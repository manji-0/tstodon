import {
  ActivityId,
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  RemoteStatus,
  type RemoteActor,
  Hostname,
} from "@tstodon/domain";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import { suspendedDomains } from "./admin-domain-block-store";
import { fetchActivityJson, type FederatedFetchOptions } from "./federated-fetch";
import { stringList } from "./form-values";
import { replaceRemoteActorPins } from "./remote-actor-pin-store";
import { recordRemoteBoost } from "./remote-boost";
import { remoteActorFromDocument } from "./remote-actor-fetch";
import {
  claimRemoteOutboxBackfill,
  findRemoteActorByUri,
  releaseRemoteOutboxBackfill,
  upsertRemoteActor,
} from "./remote-actor-store";
import { type CollectionPage, fetchCollectionPage, firstCollectionPage } from "./remote-collection";
import { persistAnnouncedObject, persistRemoteObject } from "./remote-status-persist";
import { type JobPage, measureJobPage } from "./metrics";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

/** How long a backfilled outbox counts as fresh before a profile view fetches it again. */
export const OUTBOX_BACKFILL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Outbox pages read per backfill, the first included. Each later page is its
 * own queued job, so a deep outbox never grows one invocation, and a profile
 * gets at most this many pages of history.
 */
export const OUTBOX_BACKFILL_PAGE_LIMIT = 5;

type BackfillRemoteOutbox = Extract<OutboxJobValue, { kind: "BackfillRemoteOutbox" }>;

/**
 * Queue a backfill of `actorUri`'s outbox unless one ran within the TTL.
 * Best effort and off the request path: the profile renders what is cached.
 */
export const requestRemoteOutboxBackfill = async (env: Env, actorUri: string): Promise<void> => {
  const claimed = await claimRemoteOutboxBackfill(env.DB, actorUri, OUTBOX_BACKFILL_TTL_MS);
  if (claimed.isErr() || claimed.value === undefined) {
    return;
  }
  const job = OutboxJob.parse({ kind: "BackfillRemoteOutbox", actorUri });
  if (job.isErr()) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value);
  } catch {
    console.error(JSON.stringify({ kind: "OutboxBackfillNotQueued", actorUri }));
    await releaseRemoteOutboxBackfill(env.DB, actorUri, claimed.value);
  }
};

const AudienceSchema = z.union([z.string(), z.array(z.string())]).optional();

const ObjectReferenceSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1), to: AudienceSchema, cc: AudienceSchema }).passthrough(),
]);

const OutboxItemSchema = z.object({
  type: z.union([z.literal("Create"), z.literal("Announce")]),
  id: ActivityId.schema,
  actor: z.string().min(1),
  object: ObjectReferenceSchema,
  to: AudienceSchema,
  cc: AudienceSchema,
});

const parseOutboxItem = schemaResult(OutboxItemSchema);

const urlHost = (href: string): string | undefined => {
  try {
    return new URL(href).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * Store one outbox item: a public `Create` of the actor's own note, or a
 * public `Announce` as a boost. Ids sort at the item's publish time, and
 * nothing fans out or notifies, since these are old posts. An embedded
 * object is trusted only when it comes from the actor's host; an announced
 * note from elsewhere is fetched with the boost path's origin checks.
 */
const backfillOutboxItem = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  raw: unknown,
  options: FederatedFetchOptions,
): Promise<void> => {
  const item = parseOutboxItem(raw);
  if (item.isErr() || item.value.actor !== actor.actorUri) {
    return;
  }
  const actorHost = urlHost(actor.actorUri);
  const object = item.value.object;
  // A `Create` is as visible as its note, as Mastodon reads it; servers
  // (tstodon among them) may address only the note.
  const audience = item.value.type === "Create" && typeof object !== "string" ? object : item.value;
  const visibility = RemoteStatus.visibilityFromAudience(
    stringList(audience.to),
    stringList(audience.cc),
  );
  if (
    urlHost(item.value.id) !== actorHost ||
    (visibility.kind !== "Public" && visibility.kind !== "Unlisted")
  ) {
    return;
  }
  const objectUri = typeof object === "string" ? object : object.id;
  const fromActorHost = urlHost(objectUri) === actorHost;
  const persist = { ...options, idClock: "Published" } as const;
  if (item.value.type === "Create") {
    if (fromActorHost) {
      await persistRemoteObject(env, identity, actor, object, persist);
    }
    return;
  }
  const announced = await persistAnnouncedObject(
    env,
    identity,
    actor,
    fromActorHost ? object : objectUri,
    persist,
  );
  if (announced.isOk()) {
    await recordRemoteBoost(
      env.DB,
      identity,
      actor.actorUri,
      { id: item.value.id, object: objectUri },
      raw,
      announced.value,
      "Published",
    );
  }
};

/**
 * The cached actor, refetched once when it was cached before collection URIs
 * were kept, so its outbox can be found.
 */
const withCollections = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
): Promise<RemoteActor> => {
  if (actor.outboxUri || actor.featuredUri) {
    return actor;
  }
  const raw = await fetchActivityJson(identity, actor.actorUri, options);
  const refreshed = raw.isOk() ? remoteActorFromDocument(raw.value, actor.actorUri) : undefined;
  if (!refreshed || refreshed.isErr()) {
    return actor;
  }
  const stored = await upsertRemoteActor(env.DB, refreshed.value);
  return stored.isOk() ? stored.value : actor;
};

export const processBackfillRemoteOutboxJob = (
  env: Env,
  job: BackfillRemoteOutbox,
): Promise<"ok" | "retry"> => measureJobPage(env, job.kind, () => backfillRemoteOutbox(env, job));

/** `size` is the outbox items fetched; `chained` is whether the next page was queued. */
const backfillRemoteOutbox = async (env: Env, job: BackfillRemoteOutbox): Promise<JobPage> => {
  const identity = parseInstanceIdentity(env);
  const cached = await findRemoteActorByUri(env.DB, job.actorUri);
  if (identity.isErr() || cached.isErr()) {
    return { outcome: "retry", size: 0, chained: false };
  }
  const suspended = await suspendedDomains(env.DB);
  if (!cached.value || suspended.has(Hostname.ofAuthority(cached.value.domain))) {
    return { outcome: "ok", size: 0, chained: false };
  }
  const options: FederatedFetchOptions = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: suspended,
  };
  const { from } = job;
  // A later page is a link taken from the remote's document; it must stay on
  // the actor's host, like the items it holds.
  if (from.kind === "Page") {
    const page =
      urlHost(from.pageUri) === urlHost(cached.value.actorUri)
        ? await fetchCollectionPage(identity.value, from.pageUri, options)
        : undefined;
    const chained = page
      ? await backfillPage(env, identity.value, cached.value, page, from.depth, options)
      : false;
    return { outcome: "ok", size: page?.items.length ?? 0, chained };
  }
  const actor = await withCollections(env, identity.value, cached.value, options);
  const outbox = actor.outboxUri
    ? await firstCollectionPage(identity.value, actor.outboxUri, options)
    : undefined;
  const chained = outbox
    ? await backfillPage(env, identity.value, actor, outbox, 0, options)
    : false;
  const featured = actor.featuredUri
    ? await firstCollectionPage(identity.value, actor.featuredUri, options)
    : undefined;
  if (featured) {
    await backfillPins(env, identity.value, actor, featured.items, options);
  }
  return { outcome: "ok", size: outbox?.items.length ?? 0, chained };
};

/**
 * Store one outbox page's items, then queue the page after it, until
 * `OUTBOX_BACKFILL_PAGE_LIMIT` pages have been read. `depth` counts the pages
 * before this one. Resolves to whether the next page was queued.
 */
const backfillPage = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  page: CollectionPage,
  depth: number,
  options: FederatedFetchOptions,
): Promise<boolean> => {
  for (const item of page.items) {
    await backfillOutboxItem(env, identity, actor, item, options);
  }
  if (page.next === undefined || depth + 1 >= OUTBOX_BACKFILL_PAGE_LIMIT) {
    return false;
  }
  const job = OutboxJob.parse({
    kind: "BackfillRemoteOutbox",
    actorUri: actor.actorUri,
    from: { kind: "Page", pageUri: page.next, depth: depth + 1 },
  });
  if (job.isErr()) {
    return false;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value);
    return true;
  } catch {
    console.error(
      JSON.stringify({ kind: "OutboxBackfillPageNotQueued", actorUri: actor.actorUri }),
    );
    return false;
  }
};

const parseObjectReference = schemaResult(ObjectReferenceSchema);

/**
 * Store the actor's pinned notes from its `featured` items (notes or their
 * URIs, from the actor's host) and make them its pins, in order.
 */
const backfillPins = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  items: ReadonlyArray<unknown>,
  options: FederatedFetchOptions,
): Promise<void> => {
  const actorHost = urlHost(actor.actorUri);
  const statusIds: string[] = [];
  for (const raw of items) {
    const item = parseObjectReference(raw);
    if (item.isErr()) {
      continue;
    }
    const uri = typeof item.value === "string" ? item.value : item.value.id;
    if (urlHost(uri) !== actorHost) {
      continue;
    }
    const stored = await persistRemoteObject(env, identity, actor, item.value, {
      ...options,
      idClock: "Published",
    });
    if (stored.isOk() && stored.value?.actorUri === actor.actorUri) {
      statusIds.push(stored.value.id);
    }
  }
  await replaceRemoteActorPins(env.DB, actor.actorUri, statusIds);
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([OutboxItemSchema]);
