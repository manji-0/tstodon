import {
  FollowersSynchronization,
  InstanceIdentity,
  type OutboxJob,
  type RemoteActor,
  SYNCHRONIZATION_MAX_PAGES,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { findAccountById, findAccountByUsername } from "./account-store";
import { parseLocalActorUsername } from "./activitypub";
import { suspendedDomains } from "./admin-domain-block-store";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import {
  type FollowersSynchronizationKey,
  type LocalFollowOfActor,
  localFollowsOfActor,
  lockFollowersSynchronization,
  unlockFollowersSynchronization,
} from "./followers-synchronization-store";
import { instanceActorFetchSigner } from "./instance-actor";
import { sendFollowUndo, unfollowRemoteActor } from "./outbound-follow";
import { acceptOutboundFollow } from "./outbound-follow-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { followersSynchronizationDisabled } from "./followers-synchronization";

type SynchronizeFollowersJob = Extract<OutboxJob, { kind: "SynchronizeFollowers" }>;

/**
 * `JsonLdHelper#non_matching_uri_hosts?`: `url` is not http(s), or its host
 * is not `base`'s, ignoring case.
 */
const sameHost = (base: string, url: string): boolean => {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return false;
  }
  const a = URL.parse(base)?.hostname;
  const b = URL.parse(url)?.hostname;
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
};

/** The digest of the local followers of `actor` (`Account#local_followers_hash`). */
const localFollowersDigest = (
  identity: InstanceIdentity,
  follows: ReadonlyArray<LocalFollowOfActor>,
): Promise<string> =>
  FollowersSynchronization.digest(
    follows
      .filter((follow) => follow.state.kind === "Accepted")
      .map((follow) => InstanceIdentity.actorUrl(identity, follow.username)),
  );

/**
 * Act on a `Collection-Synchronization` header of a verified inbox POST from
 * `signer`, as Mastodon's `InboxesController#process_collection_synchronization`
 * and `PrepareFollowersSynchronizationService`: when it names the signer's
 * followers collection, a URL on the signer's host, and a digest other than
 * that of the local accounts following the signer, queue the job that reads
 * the list, unless the same job is queued already. A header that does not
 * parse is logged and ignored; nothing here fails the delivery.
 */
export const prepareFollowersSynchronization = async (
  env: Env,
  identity: InstanceIdentity,
  signer: RemoteActor,
  raw: string | undefined,
): Promise<void> => {
  if (raw === undefined || raw.trim() === "" || followersSynchronizationDisabled(env)) {
    return;
  }
  const params = FollowersSynchronization.parseHeader(raw);
  if (params.isErr()) {
    console.warn(
      JSON.stringify({
        kind: "CollectionSynchronizationUnparsed",
        reason: params.error.kind,
        actor: signer.actorUri,
      }),
    );
    return;
  }
  const url = params.value.get("url") ?? "";
  const digest = params.value.get("digest");
  if (
    signer.followersUri === undefined ||
    params.value.get("collectionId") !== signer.followersUri ||
    !sameHost(signer.actorUri, url)
  ) {
    return;
  }
  const follows = await localFollowsOfActor(env.DB, signer.actorUri);
  if (follows.isErr()) {
    console.error(
      JSON.stringify({ kind: "FollowersSynchronizationUnread", message: follows.error.message }),
    );
    return;
  }
  if ((await localFollowersDigest(identity, follows.value)) === digest) {
    return;
  }
  const key: FollowersSynchronizationKey = {
    actorUri: signer.actorUri,
    url,
    digest: digest ?? "",
  };
  const now = new Date();
  const locked = await lockFollowersSynchronization(env.DB, key, now);
  if (locked.isErr() || !locked.value) {
    return;
  }
  const job: SynchronizeFollowersJob = {
    kind: "SynchronizeFollowers",
    actorUri: signer.actorUri,
    url,
    ...(digest === undefined ? {} : { digest }),
  };
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
  } catch (cause) {
    console.error(
      JSON.stringify({
        kind: "FollowersSynchronizationNotQueued",
        actor: signer.actorUri,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    await unlockFollowersSynchronization(env.DB, key, now);
  }
};

/**
 * A collection or one of its pages, as `SynchronizeFollowersService` reads
 * it: `first` and `next` link to (or embed) a page, and the items are where
 * the `type` says (`collection_page_items`).
 */
const CollectionDocumentSchema = z.looseObject({
  type: z.unknown().optional(),
  items: z.unknown().optional(),
  orderedItems: z.unknown().optional(),
  first: z.unknown().optional(),
  next: z.unknown().optional(),
});
type CollectionDocument = z.infer<typeof CollectionDocumentSchema>;
const parseCollectionDocument = schemaResult(CollectionDocumentSchema);

/** `as_array(collection_page_items(page))`. */
const pageItems = (page: CollectionDocument): ReadonlyArray<unknown> => {
  const items =
    page.type === "Collection" || page.type === "CollectionPage"
      ? page.items
      : page.type === "OrderedCollection" || page.type === "OrderedCollectionPage"
        ? page.orderedItems
        : undefined;
  if (items === undefined || items === null) {
    return [];
  }
  return Array.isArray(items) ? items : [items];
};

/** Ruby's `present?` for a link or an embedded page. */
const present = (value: unknown): boolean =>
  typeof value === "string"
    ? value.trim() !== ""
    : typeof value === "object" && value !== null && Object.keys(value).length > 0;

type PageRead =
  | Readonly<{ kind: "Page"; page: CollectionDocument }>
  /** No page: the link was refused or answered no collection. */
  | Readonly<{ kind: "None" }>
  /** The server did not answer: the job is tried again. */
  | Readonly<{ kind: "Unavailable" }>;

/**
 * `fetch_collection_page`: an embedded page as it is, else the page at the
 * link, refused when `referenceUri` is given and the link is on another host.
 */
const readPage = async (
  identity: InstanceIdentity,
  link: unknown,
  options: FederatedFetchOptions,
  referenceUri?: string,
): Promise<PageRead> => {
  if (typeof link !== "string") {
    const embedded = parseCollectionDocument(link);
    return embedded.isOk() ? { kind: "Page", page: embedded.value } : { kind: "None" };
  }
  if (referenceUri !== undefined && !sameHost(referenceUri, link)) {
    return { kind: "None" };
  }
  const fetched = await fetchActivityJson(identity, link, options);
  if (fetched.isErr()) {
    return fetched.error.kind === "VerificationUnavailable"
      ? { kind: "Unavailable" }
      : { kind: "None" };
  }
  const page = parseCollectionDocument(fetched.value);
  return page.isOk() ? { kind: "Page", page: page.value } : { kind: "None" };
};

type Reading = Readonly<{
  env: Env;
  identity: InstanceIdentity;
  actor: RemoteActor;
  /** The local follows of the actor, by lowercased username. */
  follows: ReadonlyMap<string, LocalFollowOfActor>;
}>;

/**
 * `handle_unexpected_outgoing_follows!` for the local accounts a page lists:
 * a follow stays, a request is accepted as its `Accept` would have, and an
 * account with neither tells the actor to drop the follow it holds. That
 * `Undo` names no `Follow` id this server ever sent, exactly as Mastodon's.
 * Resolves to the ids of the local accounts listed.
 */
const handleListedFollowers = async (
  reading: Reading,
  usernames: ReadonlyArray<string>,
): Promise<void> => {
  const { env, identity, actor, follows } = reading;
  for (const username of usernames) {
    const follow = follows.get(username.toLowerCase());
    const action = FollowersSynchronization.listedFollowAction(follow?.state);
    switch (action.kind) {
      case "Keep":
        break;
      case "Authorize":
        if (follow !== undefined) {
          await acceptOutboundFollow(env.DB, {
            actorUri: actor.actorUri,
            followActivityId: follow.followActivityId,
            accountId: follow.accountId,
          });
        }
        break;
      case "Undo": {
        const account = await findAccountByUsername(env.DB, username);
        if (account.isOk() && account.value !== undefined) {
          const actorUrl = InstanceIdentity.actorUrl(identity, account.value.username);
          await sendFollowUndo(env, identity, account.value, actor, `${actorUrl}#follows/`);
        }
        break;
      }
    }
  }
};

/** The local account usernames `uris` name as actors (`uris_to_local_accounts`). */
const localUsernames = (identity: InstanceIdentity, uris: ReadonlyArray<string>): string[] =>
  uris.flatMap((uri) => {
    const username = parseLocalActorUsername(identity, uri);
    return username !== undefined && InstanceIdentity.actorUrl(identity, username) === uri
      ? [username]
      : [];
  });

type Synchronized =
  /** Every page was read: what they listed. */
  | Readonly<{ kind: "Complete"; uris: ReadonlyArray<string>; listedIds: ReadonlySet<string> }>
  /** A page was missing, unreadable, or past the page limit: nothing is removed. */
  | Readonly<{ kind: "Incomplete" }>
  | Readonly<{ kind: "Unavailable" }>;

/** `process_collection!`: read up to {@link SYNCHRONIZATION_MAX_PAGES} pages, handling each. */
const readCollection = async (
  reading: Reading,
  url: string,
  options: FederatedFetchOptions,
): Promise<Synchronized> => {
  const { identity, actor } = reading;
  const root = await readPage(identity, url, options, actor.actorUri);
  if (root.kind !== "Page") {
    return root.kind === "Unavailable" ? root : { kind: "Incomplete" };
  }
  let current: PageRead = present(root.page.first)
    ? await readPage(identity, root.page.first, options, actor.actorUri)
    : root;
  const uris: string[] = [];
  const listedIds = new Set<string>();
  for (let pages = 0; current.kind === "Page";) {
    const items = pageItems(current.page);
    const pageUris = items.filter((item): item is string => typeof item === "string");
    // Mastodon hashes each item as a string and fails on anything else.
    if (pageUris.length !== items.length) {
      return { kind: "Incomplete" };
    }
    uris.push(...pageUris);
    const usernames = localUsernames(identity, pageUris);
    await handleListedFollowers(reading, usernames);
    for (const username of usernames) {
      const follow = reading.follows.get(username.toLowerCase());
      if (follow !== undefined) {
        listedIds.add(follow.accountId);
      }
    }
    pages += 1;
    if (!present(current.page.next)) {
      return { kind: "Complete", uris, listedIds };
    }
    if (pages >= SYNCHRONIZATION_MAX_PAGES) {
      return { kind: "Incomplete" };
    }
    current = await readPage(identity, current.page.next, options);
  }
  return current.kind === "Unavailable" ? current : { kind: "Incomplete" };
};

/**
 * `SynchronizeFollowersService`: read the actor's partial followers
 * collection, fix each listed follow, and, when every page was read and
 * they add up to the header's digest (or it named none), unfollow the
 * actor for each local account it no longer lists, sending the `Undo`.
 */
const synchronize = async (env: Env, job: SynchronizeFollowersJob): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  const actor = await findRemoteActorByUri(env.DB, job.actorUri);
  if (identity.isErr() || actor.isErr()) {
    return "retry";
  }
  if (actor.value === undefined) {
    return "ok";
  }
  const follows = await localFollowsOfActor(env.DB, job.actorUri);
  if (follows.isErr()) {
    return "retry";
  }
  const reading: Reading = {
    env,
    identity: identity.value,
    actor: actor.value,
    follows: new Map(follows.value.map((follow) => [follow.username.toLowerCase(), follow])),
  };
  const options: FederatedFetchOptions = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
    fetchSigner: instanceActorFetchSigner(env.DB, identity.value),
  };
  const read = await readCollection(reading, job.url, options);
  if (read.kind !== "Complete") {
    return read.kind === "Unavailable" ? "retry" : "ok";
  }
  if (
    job.digest !== undefined &&
    !(await FollowersSynchronization.matchesDigest(read.uris, job.digest))
  ) {
    return "ok";
  }
  for (const follow of follows.value) {
    if (follow.state.kind !== "Accepted" || read.listedIds.has(follow.accountId)) {
      continue;
    }
    const account = await findAccountById(env.DB, follow.accountId);
    if (account.isOk() && account.value !== undefined) {
      await unfollowRemoteActor(env, identity.value, account.value, actor.value);
    }
  }
  return "ok";
};

/**
 * Run a `SynchronizeFollowers` job and free its lock once it has run, so the
 * next header that differs queues it again (`lock: :until_executed`). A job
 * to be retried keeps it.
 */
export const processSynchronizeFollowersJob = async (
  env: Env,
  job: SynchronizeFollowersJob,
): Promise<"ok" | "retry"> => {
  const outcome = await synchronize(env, job);
  if (outcome === "ok") {
    await unlockFollowersSynchronization(
      env.DB,
      { actorUri: job.actorUri, url: job.url, digest: job.digest ?? "" },
      new Date(),
    );
  }
  return outcome;
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([CollectionDocumentSchema]);
