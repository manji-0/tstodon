import { recordDeliveryReachability } from "../delivery-domain-health-store";
import {
  ACTIVITY_STREAMS,
  type ApActorCollectionJSON,
  type ApActorCollectionPageJSON,
  type ApFeaturedCollectionJSON,
  type ApFeaturedTagsCollectionJSON,
  type ApFollowersSynchronizationCollectionJSON,
  type ApOutboxJSON,
  type ApOutboxPageJSON,
  type ApRepliesDocumentJSON,
  type ApRepliesPageDocumentJSON,
  type ApStatusDocumentJSON,
} from "@tstodon/api/activitypub";
import {
  ActivityId,
  type CollectionCursor,
  CollectionPage,
  type CollectionPageLinks,
  CoveredHosts,
  FollowersSynchronization,
  Hostname,
  InboxActivity,
  InstanceIdentity,
  type LocalAccount,
  type LocalStatus as LocalStatusValue,
  RemoteActor,
  RepliesPage,
  Visibility,
} from "@tstodon/domain";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "../d1";
import { findAccountByUsername, findAccountsByIds, isDeletedAccountName } from "../account-store";
import { findBlock } from "../block-mute-store";
import { loadCustomEmojis } from "../custom-emoji-store";
import { isActorDomainBlocked } from "../domain-block-store";
import {
  activityPayloadFromJson,
  featuredCollectionUri,
  featuredTagsCollectionUri,
  hashtagObject,
  announceActivity,
  localNoteRef,
  noteCreateActivity,
  parseLocalActorUsername,
} from "../activitypub";
import { jsonRepositoryError } from "../http";
import {
  checkBodyDigest,
  checkSignatureStrength,
  parseRequestSignature,
  type VerificationKey,
  verifyInboxRequest,
} from "../http-signature";
import { type InboxRefusal, recordInboxRefusal } from "../inbox-refusal";
import { localActorDocument } from "../local-actor";
import { suspendedDomains } from "../admin-domain-block-store";
import { getRemoteActorModeration } from "../remote-actor-moderation-store";
import { listDomainSuspendedActors } from "../domain-block-limits";
import { signedFetchActor } from "../signed-fetch";
import {
  authorizedFetchEnabled,
  authorizeObjectFetch,
  type FetchAccess,
  requireSignedFetch,
  restrictedActorDocument,
} from "../authorized-fetch";
import { remoteFollowerUrisUnder } from "../followers-synchronization-store";
import { prepareFollowersSynchronization } from "../remote-followers-synchronization";
import {
  claimInboxActivity,
  completeInboxActivity,
  inboxClaimKey,
  releaseInboxActivity,
} from "../inbox-store";
import { limitInboxDelivery } from "../rate-limit";
import { dispatchInbox } from "../inbox/dispatch";
import type { InboxSigner, InboxTarget } from "../inbox/handler";
import { listOutboxStatusIds, type OutboxReader } from "../actor-outbox-store";
import { loadLocalNoteDocument, loadLocalNoteDocuments } from "../local-note-document";
import type { CustomEmoji } from "../emoji";
import { accountCounts } from "../account-count-store";
import { findAccountStanding } from "../account-moderation-store";
import { findAccountProfile } from "../account-profile-store";
import { type IdCursor } from "../id-cursor";
import { resolveKeyOwner } from "../remote-actor-fetch";
import { verifyForwardedActivity } from "../inbox-forward";
import { findRemoteActorByUri, findRemoteFollow } from "../remote-actor-store";
import { RemoteDeleteTarget } from "../remote-delete";
import { allowListAdmits, federationAllowHosts, parseInstanceIdentity } from "../runtime-config";
import { statusTargetRef, statusTargetRefs } from "../quote-uri";
import { findQuoteById } from "../quote-store";
import {
  quoteAuthorizationDocument,
  localQuoteAuthorization,
} from "../quote-authorization-document";
import { ActivityJsonSchema, nameCollectionActivity } from "../activitypub-wire";
import { parseJsonText } from "../json-column";
import { assertNever, schemaResult } from "@tstodon/core";
import { listFollowers, listFollowing } from "../follow-store";
import { hasStatusRemoteMention } from "../mention-store";
import { loadNotesReplies, repliedNote, repliesCollectionUri } from "../note-replies";
import { loadNoteRepliesPage } from "../note-replies-page";
import { findStatusById, findStatusesByIds } from "../status-store";
import { listPinnedStatuses } from "../status-pin-store";
import { listFeaturedTags } from "../tag-store";
import { RemoteAccountId } from "../remote-account-id";
import { MAX_JSON_BYTES, readBodyText } from "../body-limit";
import {
  instanceActorDocument,
  instanceActorFetchSigner,
  instanceActorKeys,
} from "../instance-actor";

const parseActivityJson = schemaResult(ActivityJsonSchema);

const RepliesQuerySchema = z.object({
  page: z.string().optional(),
  only_other_accounts: z.string().optional(),
  min_id: z.string().max(64).optional(),
});
const parseRepliesQuery = schemaResult(RepliesQuerySchema);

/**
 * Whether `account` blocks the remote actor that signed a fetch, or its
 * domain: Mastodon then shows that fetcher nothing of the account's.
 */
const blocksFetcher = async (
  db: D1Database,
  account: LocalAccount,
  fetcherUri: string,
): Promise<Result<boolean, RepositoryError>> => {
  const [blocked, domainBlocked] = await Promise.all([
    findBlock(db, account.id, fetcherUri),
    isActorDomainBlocked(db, account.id, fetcherUri),
  ]);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (domainBlocked.isErr()) {
    return err(domainBlocked.error);
  }
  return ok(blocked.value || domainBlocked.value);
};

const jsonLd = {
  "content-type": "application/activity+json",
};

/** Mastodon's `forbidden` body. */
const NOT_ALLOWED = { error: "This action is not allowed", kind: "Forbidden" } as const;

type DocumentOwner =
  | Readonly<{ kind: "Served"; account: LocalAccount }>
  | Readonly<{ kind: "Refused"; response: Response }>;

/**
 * The local account whose document a route serves, as Mastodon's
 * `AccountOwnedConcern`: 404 for a name nobody has, and, cached for 3
 * minutes, 410 for a deleted account (`permanently_unavailable?`) and 403
 * for a suspended one (`check_account_suspension`). In secure mode the
 * refusal stays `private`, as every answer there does.
 */
const documentOwner = async (
  c: Context<{ Bindings: Env }>,
  access: FetchAccess,
  username: string,
): Promise<DocumentOwner> => {
  const refuse = (response: Response): DocumentOwner => ({ kind: "Refused", response });
  const cacheControl = `max-age=180, ${access.kind === "Public" ? "public" : "private"}`;
  const account = await findAccountByUsername(c.env.DB, username);
  if (account.isErr()) {
    return refuse(jsonRepositoryError(c, account.error.message));
  }
  if (!account.value) {
    const deleted = await isDeletedAccountName(c.env.DB, username);
    if (deleted.isErr()) {
      return refuse(jsonRepositoryError(c, deleted.error.message));
    }
    if (!deleted.value) {
      return refuse(c.json({ kind: "NotFound" }, 404));
    }
    c.header("Cache-Control", cacheControl);
    return refuse(c.json({ kind: "Gone" }, 410));
  }
  const standing = await findAccountStanding(c.env.DB, account.value.id);
  if (standing.isErr()) {
    return refuse(jsonRepositoryError(c, standing.error.message));
  }
  if (standing.value.kind === "Suspended") {
    c.header("Cache-Control", cacheControl);
    return refuse(c.json(NOT_ALLOWED, 403));
  }
  return { kind: "Served", account: account.value };
};

export const getUsersByUsername = async (c: Context<{ Bindings: Env }, "/users/:username">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value, "actor");
  if (access.kind === "Denied") {
    return access.response;
  }
  const account = await findAccountByUsername(c.env.DB, c.req.param("username"));
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    // As Mastodon: a deleted account's actor is gone for good, an unknown name is not found.
    const deleted = await isDeletedAccountName(c.env.DB, c.req.param("username"));
    if (deleted.isErr()) {
      return jsonRepositoryError(c, deleted.error.message);
    }
    return deleted.value ? c.json({ kind: "Gone" }, 410) : c.json({ kind: "NotFound" }, 404);
  }
  const document = await localActorDocument(c.env, identity.value, account.value);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  return c.json(
    access.kind === "Restricted" ? restrictedActorDocument(document.value) : document.value,
    200,
    jsonLd,
  );
};

export const getUsersByUsernameStatusesById = async (
  c: Context<{ Bindings: Env }, "/users/:username/statuses/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const owner = await documentOwner(c, access, c.req.param("username"));
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const { account } = owner;
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value || status.value.kind !== "LocalNote" || status.value.accountId !== account.id) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const visibility = status.value.visibility.kind;
  // As Mastodon's `NoteSerializer`, whatever the note's own visibility.
  const replies = await loadNotesReplies(c.env.DB, [
    repliedNote(identity.value, account, status.value.id),
  ]);
  if (replies.isErr()) {
    return jsonRepositoryError(c, replies.error.message);
  }
  const document = await loadLocalNoteDocument(c.env, identity.value, account, status.value, {
    replies: replies.value.get(status.value.id),
    emojis: await loadCustomEmojis(c.env, identity.value.mediaPublicBaseUrl),
  });
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  const note = document.value;
  if (visibility !== "Public" && visibility !== "Unlisted") {
    if (!(await readsPrivateNote(c, identity.value, account, status.value.id, note))) {
      return c.json({ kind: "NotFound" }, 404);
    }
  }
  return c.json(note, 200, jsonLd);
};

/**
 * Whether the signer of this GET may read the followers-only or direct note
 * `statusId`, as Mastodon's `StatusPolicy#show?` under authorized fetch: an
 * actor it addresses or mentions, silently too. When it may, the answer is
 * marked for that signer alone, never for a shared cache.
 */
const readsPrivateNote = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  author: LocalAccount,
  statusId: string,
  note: Pick<ApStatusDocumentJSON, "to" | "cc" | "attributedTo">,
): Promise<boolean> => {
  const signer = await signedFetchActor(c.env, identity, c.req.raw);
  if (!signer || !(await noteAddresses(c.env.DB, statusId, note, author, signer.actorUri))) {
    return false;
  }
  c.header("Cache-Control", "private");
  c.header("Vary", "Signature");
  return true;
};

/**
 * A note's `replies` collection, or one page of it (`?page=true`), as
 * Mastodon's `RepliesController`: public and unlisted replies, the author's
 * own first, then every other account's, local or cached from another
 * server, in one id order; a local reply embedded as its note. A followers-only or direct
 * note's collection is served as the note is ({@link readsPrivateNote}). 404
 * for a note the fetcher may not read, and for a signed fetcher the author
 * blocks.
 */
export const getUsersByUsernameStatusesByIdReplies = async (
  c: Context<{ Bindings: Env }, "/users/:username/statuses/:id/replies">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const query = parseRepliesQuery(c.req.query());
  if (query.isErr()) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const owner = await documentOwner(c, access, c.req.param("username"));
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const { account } = owner;
  const status = await findStatusById(c.env.DB, c.req.param("id"));
  if (status.isErr()) {
    return jsonRepositoryError(c, status.error.message);
  }
  if (!status.value || status.value.kind !== "LocalNote" || status.value.accountId !== account.id) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const visibility = status.value.visibility.kind;
  if (visibility !== "Public" && visibility !== "Unlisted") {
    const document = await loadLocalNoteDocument(c.env, identity.value, account, status.value, {
      emojis: [],
    });
    if (document.isErr()) {
      return jsonRepositoryError(c, document.error.message);
    }
    if (!(await readsPrivateNote(c, identity.value, account, status.value.id, document.value))) {
      return c.json({ kind: "NotFound" }, 404);
    }
  }
  if (access.kind === "Signed") {
    const blocked = await blocksFetcher(c.env.DB, account, access.actor.actorUri);
    if (blocked.isErr()) {
      return jsonRepositoryError(c, blocked.error.message);
    }
    if (blocked.value) {
      return c.json({ kind: "NotFound" }, 404);
    }
  }
  const note = repliedNote(identity.value, account, status.value.id);
  const page = await loadNoteRepliesPage(c.env, identity.value, note, query.value);
  if (page.isErr()) {
    return jsonRepositoryError(c, page.error.message);
  }
  if (!RepliesPage.truthy(query.value.page)) {
    // Without `page`, the collection with the page its query names as `first`.
    const collection: ApRepliesDocumentJSON = {
      "@context": ACTIVITY_STREAMS,
      id: repliesCollectionUri(note.uri),
      type: "Collection",
      first: page.value,
    };
    return c.json(collection, 200, jsonLd);
  }
  const document: ApRepliesPageDocumentJSON = { "@context": ACTIVITY_STREAMS, ...page.value };
  return c.json(document, 200, jsonLd);
};

/**
 * The stamp of an accepted quote of one of this account's public or unlisted
 * statuses, as Mastodon's `QuoteAuthorizationsController`; 404 otherwise.
 */
export const getUsersByUsernameQuoteAuthorizationsById = async (
  c: Context<{ Bindings: Env }, "/users/:username/quote_authorizations/:id">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const owner = await documentOwner(c, access, c.req.param("username"));
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const { account } = owner;
  const quote = await findQuoteById(c.env.DB, c.req.param("id"));
  if (quote.isErr()) {
    return jsonRepositoryError(c, quote.error.message);
  }
  if (
    !quote.value ||
    quote.value.state.kind !== "Accepted" ||
    quote.value.quoted.kind !== "LocalStatus"
  ) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const quoted = await findStatusById(c.env.DB, quote.value.quoted.statusId);
  if (quoted.isErr()) {
    return jsonRepositoryError(c, quoted.error.message);
  }
  const visibility = quoted.value?.visibility.kind;
  const quoting = await statusTargetRef(c.env, identity.value, quote.value.quoting);
  if (quoting.isErr()) {
    return jsonRepositoryError(c, quoting.error.message);
  }
  if (
    !quoted.value ||
    quoted.value.accountId !== account.id ||
    (visibility !== "Public" && visibility !== "Unlisted") ||
    !quoting.value
  ) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const target = localNoteRef(identity.value, account, quoted.value.id);
  // Mastodon's `authorize quoted_status, :show?`: a signed fetcher the author
  // blocks, or whose domain the author blocks, is refused. An unsigned fetch
  // of a public or unlisted stamp is served, as public fetch mode.
  const signer = await signedFetchActor(c.env, identity.value, c.req.raw);
  if (signer) {
    const [blocked, domainBlocked] = await Promise.all([
      findBlock(c.env.DB, account.id, signer.actorUri),
      isActorDomainBlocked(c.env.DB, account.id, signer.actorUri),
    ]);
    if (blocked.isErr()) {
      return jsonRepositoryError(c, blocked.error.message);
    }
    if (domainBlocked.isErr()) {
      return jsonRepositoryError(c, domainBlocked.error.message);
    }
    if (blocked.value || domainBlocked.value) {
      return c.json({ kind: "NotFound" }, 404);
    }
  }
  const document = quoteAuthorizationDocument(
    localQuoteAuthorization(target, quote.value.id, quoting.value.uri),
  );
  if (access.kind === "Public") {
    c.header("Cache-Control", "max-age=30, public");
    // The body is public, but a signed fetcher the author blocks is refused.
    c.header("Vary", "Signature");
  }
  return c.json(document, 200, jsonLd);
};

/**
 * Does the note's audience include this remote actor: named in `to`/`cc`,
 * mentioned silently (a quote's quoted author, a mention an edit dropped), or
 * an accepted follower when the author's followers collection is addressed?
 */
const noteAddresses = async (
  db: D1Database,
  statusId: string,
  note: Pick<ApStatusDocumentJSON, "to" | "cc" | "attributedTo">,
  author: LocalAccount,
  actorUri: string,
): Promise<boolean> => {
  const audience = [...note.to, ...note.cc];
  if (audience.includes(actorUri)) {
    return true;
  }
  const mentioned = await hasStatusRemoteMention(db, statusId, actorUri);
  if (mentioned.isOk() && mentioned.value) {
    return true;
  }
  if (!audience.includes(`${note.attributedTo}/followers`)) {
    return false;
  }
  const follow = await findRemoteFollow(db, author.id, actorUri);
  return follow.isOk() && follow.value?.requestKind === "Fulfilled";
};

const parseCollectionQuery = schemaResult(CollectionPage.querySchema);

const idCursorOf = (cursor: CollectionCursor): IdCursor => {
  switch (cursor.kind) {
    case "Newest":
      return {};
    case "Before":
      return { maxId: cursor.id };
    case "After":
      return { minId: cursor.id };
  }
};

/** `next` and `prev` as links into `collection`; absent where there is no page. */
const pageLinks = (
  collection: string,
  links: CollectionPageLinks,
): Readonly<{ next?: string; prev?: string }> => ({
  ...(links.next ? { next: `${collection}${CollectionPage.query(links.next)}` } : {}),
  ...(links.prev ? { prev: `${collection}${CollectionPage.query(links.prev)}` } : {}),
});

/**
 * A local account's `followers` or `following`, as Mastodon's
 * `FollowerAccountsController` / `FollowingAccountsController`. Without
 * `page`: the account's count and a link to the first page, or the count
 * alone when the account hides its collections. With `page`: 12 actor URIs,
 * newest follow first, or 403 when the account hides them, whoever asks.
 */
const followCollection = async (
  c: Context<{ Bindings: Env }, "/users/:username/followers" | "/users/:username/following">,
  name: "followers" | "following",
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const query = parseCollectionQuery(c.req.query());
  if (query.isErr()) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const owner = await documentOwner(c, access, c.req.param("username"));
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const { account } = owner;
  const [profile, counts] = await Promise.all([
    findAccountProfile(c.env.DB, account.id),
    accountCounts(c.env.DB, account.id),
  ]);
  if (profile.isErr()) {
    return jsonRepositoryError(c, profile.error.message);
  }
  if (counts.isErr()) {
    return jsonRepositoryError(c, counts.error.message);
  }
  const id = `${InstanceIdentity.actorUrl(identity.value, account.username)}/${name}`;
  const totalItems = counts.value[name];
  const hidden = profile.value.hideCollections;
  const request = CollectionPage.fromQuery(query.value, "Present");
  if (request.kind === "Root") {
    const root: ApActorCollectionJSON = {
      "@context": ACTIVITY_STREAMS,
      id,
      type: "OrderedCollection",
      totalItems,
      ...(hidden ? {} : { first: `${id}${CollectionPage.query({ kind: "Newest" }, "1")}` }),
    };
    return c.json(root, 200, jsonLd);
  }
  if (hidden) {
    return c.json(NOT_ALLOWED, 403);
  }
  const list = name === "followers" ? listFollowers : listFollowing;
  const edges = await list(
    c.env.DB,
    account.id,
    CollectionPage.FOLLOWS_LIMIT + 1,
    idCursorOf(request.cursor),
  );
  if (edges.isErr()) {
    return jsonRepositoryError(c, edges.error.message);
  }
  const page = CollectionPage.take(request.cursor, edges.value, CollectionPage.FOLLOWS_LIMIT);
  const locals = await findAccountsByIds(
    c.env.DB,
    page.items.map((edge) => edge.accountId),
  );
  if (locals.isErr()) {
    return jsonRepositoryError(c, locals.error.message);
  }
  const items = page.items.flatMap((edge) => {
    const remote = RemoteAccountId.decode(edge.accountId);
    if (remote.isOk()) {
      return [remote.value];
    }
    const local = locals.value.get(edge.accountId);
    return local ? [InstanceIdentity.actorUrl(identity.value, local.username)] : [];
  });
  const links = CollectionPage.followsLinks(
    request.cursor,
    page.items.map((edge) => edge.id),
    page.more,
  );
  const document: ApActorCollectionPageJSON = {
    "@context": ACTIVITY_STREAMS,
    id: `${id}${CollectionPage.query(request.cursor, query.value.page)}`,
    type: "OrderedCollectionPage",
    totalItems,
    partOf: id,
    ...pageLinks(id, links),
    orderedItems: items,
  };
  return c.json(document, 200, jsonLd);
};

export const getUsersByUsernameFollowers = (
  c: Context<{ Bindings: Env }, "/users/:username/followers">,
) => followCollection(c, "followers");

export const getUsersByUsernameFollowing = (
  c: Context<{ Bindings: Env }, "/users/:username/following">,
) => followCollection(c, "following");

/**
 * The account's followers on the signer's host (FEP-8fcf), as Mastodon's
 * `FollowersSynchronizationsController`: the account as any of its documents
 * (404, 410, 403), then a signature from any actor that federates here, then
 * every follower URI under the signer's scheme and authority, uncached.
 */
export const getUsersByUsernameFollowersSynchronization = async (
  c: Context<{ Bindings: Env }, "/users/:username/followers_synchronization">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const owner = await documentOwner(
    c,
    authorizedFetchEnabled(c.env) ? { kind: "Restricted" } : { kind: "Public" },
    c.req.param("username"),
  );
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const signed = await requireSignedFetch(c, identity.value);
  if (signed.kind === "Denied") {
    return signed.response;
  }
  const prefix = FollowersSynchronization.uriPrefix(signed.actor.actorUri);
  const items =
    prefix === undefined
      ? ok([])
      : await remoteFollowerUrisUnder(c.env.DB, owner.account.id, prefix);
  if (items.isErr()) {
    return jsonRepositoryError(c, items.error.message);
  }
  const document: ApFollowersSynchronizationCollectionJSON = {
    "@context": ACTIVITY_STREAMS,
    id: `${InstanceIdentity.actorUrl(identity.value, owner.account.username)}/followers_synchronization`,
    type: "OrderedCollection",
    orderedItems: items.value,
  };
  c.header("Cache-Control", "max-age=0, private");
  return c.json(document, 200, jsonLd);
};

/**
 * Who reads an outbox page, as Mastodon's `AccountStatusesFilter`: an
 * unsigned fetch reads the public and unlisted statuses; a signed one also
 * those that mention its actor, and an accepted follower the followers-only
 * ones too. A fetcher the account blocks, or whose domain it blocks, reads
 * nothing (`undefined`).
 */
const outboxReader = async (
  db: D1Database,
  account: LocalAccount,
  signer: RemoteActor | undefined,
): Promise<Result<OutboxReader | undefined, RepositoryError>> => {
  if (!signer) {
    return ok({ visibilities: ["public", "unlisted"] });
  }
  const [blocked, follow] = await Promise.all([
    blocksFetcher(db, account, signer.actorUri),
    findRemoteFollow(db, account.id, signer.actorUri),
  ]);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (follow.isErr()) {
    return err(follow.error);
  }
  if (blocked.value) {
    return ok(undefined);
  }
  return ok(
    follow.value?.requestKind === "Fulfilled"
      ? {
          visibilities: ["public", "unlisted", "private"],
          mentioned: { actorUri: signer.actorUri, visibilities: ["direct"] },
        }
      : {
          visibilities: ["public", "unlisted"],
          mentioned: { actorUri: signer.actorUri, visibilities: ["private", "direct"] },
        },
  );
};

type OutboxItem = ApOutboxPageJSON["orderedItems"][number];

/**
 * The statuses of an outbox page, in order, as Mastodon's `OutboxSerializer`
 * renders them: a note's `Create` with the note as its URI serves it now, or
 * a boost's `Announce`. Nothing for a boost whose status is gone. The notes
 * and the boosted statuses are read for the whole page at once.
 */
const outboxItems = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  statuses: ReadonlyArray<LocalStatusValue>,
  emojis: ReadonlyArray<CustomEmoji>,
): Promise<Result<OutboxItem[], RepositoryError>> => {
  const notes = statuses.flatMap((status) => (status.kind === "LocalNote" ? [status] : []));
  const boosts = statuses.flatMap((status) => (status.kind === "LocalReblog" ? [status] : []));
  const [documents, boosted] = await Promise.all([
    loadLocalNoteDocuments(
      env,
      identity,
      notes.map((note) => ({ author: account, note })),
      emojis,
    ),
    statusTargetRefs(
      env,
      identity,
      boosts.map((boost) => boost.target),
    ),
  ]);
  if (documents.isErr()) {
    return err(documents.error);
  }
  if (boosted.isErr()) {
    return err(boosted.error);
  }
  return ok(
    statuses.flatMap((status): OutboxItem[] => {
      if (status.kind === "LocalNote") {
        const document = documents.value.get(status.id);
        return document ? [noteCreateActivity(identity, account, document)] : [];
      }
      const ref = boosted.value.get(status.target.statusId);
      return ref ? [announceActivity(identity, account, status, ref)] : [];
    }),
  );
};

/**
 * The outbox, as Mastodon's `OutboxesController`. Without `page`: the
 * account's status count, and links to the newest and the oldest page. With
 * `page`: 20 of the statuses and boosts the fetcher may read, newest first,
 * rendered as they are now and paged by status id (`max_id`, `min_id`).
 */
export const getUsersByUsernameOutbox = async (
  c: Context<{ Bindings: Env }, "/users/:username/outbox">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const query = parseCollectionQuery(c.req.query());
  if (query.isErr()) {
    return c.json({ kind: "NotFound" }, 404);
  }
  const owner = await documentOwner(c, access, c.req.param("username"));
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const { account } = owner;
  const id = `${InstanceIdentity.actorUrl(identity.value, account.username)}/outbox`;
  const request = CollectionPage.fromQuery(query.value, "Truthy");
  if (request.kind === "Root") {
    const counts = await accountCounts(c.env.DB, account.id);
    if (counts.isErr()) {
      return jsonRepositoryError(c, counts.error.message);
    }
    const outbox: ApOutboxJSON = {
      "@context": ACTIVITY_STREAMS,
      id,
      type: "OrderedCollection",
      totalItems: counts.value.statuses,
      first: `${id}${CollectionPage.query({ kind: "Newest" })}`,
      last: `${id}${CollectionPage.query({ kind: "After", id: "0" })}`,
    };
    // Mastodon's `expires_in(3.minutes, public: public_fetch_mode?)`.
    c.header("Cache-Control", `max-age=180, ${access.kind === "Public" ? "public" : "private"}`);
    return c.json(outbox, 200, jsonLd);
  }
  const signer =
    access.kind === "Signed"
      ? access.actor
      : await signedFetchActor(c.env, identity.value, c.req.raw);
  const reader = await outboxReader(c.env.DB, account, signer);
  if (reader.isErr()) {
    return jsonRepositoryError(c, reader.error.message);
  }
  const ids = reader.value
    ? await listOutboxStatusIds(
        c.env.DB,
        account.id,
        reader.value,
        idCursorOf(request.cursor),
        CollectionPage.OUTBOX_LIMIT,
      )
    : ok([]);
  if (ids.isErr()) {
    return jsonRepositoryError(c, ids.error.message);
  }
  const page = CollectionPage.take(request.cursor, ids.value, CollectionPage.OUTBOX_LIMIT);
  const statuses = await findStatusesByIds(c.env.DB, page.items);
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const emojis =
    page.items.length > 0 ? await loadCustomEmojis(c.env, identity.value.mediaPublicBaseUrl) : [];
  const items = await outboxItems(
    c.env,
    identity.value,
    account,
    page.items.flatMap((statusId) => {
      const status = statuses.value.get(statusId);
      return status ? [status] : [];
    }),
    emojis,
  );
  if (items.isErr()) {
    return jsonRepositoryError(c, items.error.message);
  }
  const document: ApOutboxPageJSON = {
    "@context": ACTIVITY_STREAMS,
    id: `${id}${CollectionPage.query(request.cursor)}`,
    type: "OrderedCollectionPage",
    partOf: id,
    ...pageLinks(id, CollectionPage.outboxLinks(page.items, CollectionPage.OUTBOX_LIMIT)),
    orderedItems: items.value,
  };
  // Mastodon's `expires_in(1.minute, public: public_fetch_mode? && signed_request_account.nil?)`,
  // varying by `Signature`: what a page holds depends on who signed for it.
  c.header(
    "Cache-Control",
    `max-age=60, ${access.kind === "Public" && !signer ? "public" : "private"}`,
  );
  c.header("Vary", "Signature");
  return c.json(document, 200, jsonLd);
};

/**
 * The account's pinned public and unlisted statuses, newest pin first, as
 * Mastodon's `CollectionsController` serves `featured`. A followers-only pin
 * is left out: the collection is read without the audience check a note
 * gets, and its URI is not for everyone. In secure mode a signed fetcher the
 * account blocks, or whose domain it blocks, reads an empty collection.
 */
export const getUsersByUsernameCollectionsFeatured = async (
  c: Context<{ Bindings: Env }, "/users/:username/collections/featured">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const owner = await documentOwner(c, access, c.req.param("username"));
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const { account } = owner;
  const actor = InstanceIdentity.actorUrl(identity.value, account.username);
  const hidden =
    access.kind === "Signed"
      ? await blocksFetcher(c.env.DB, account, access.actor.actorUri)
      : ok(false);
  if (hidden.isErr()) {
    return jsonRepositoryError(c, hidden.error.message);
  }
  const pinned = hidden.value ? ok([]) : await listPinnedStatuses(c.env.DB, account.id);
  if (pinned.isErr()) {
    return jsonRepositoryError(c, pinned.error.message);
  }
  const items = pinned.value
    .filter((status) => !Visibility.isRestricted(status.visibility))
    .map((status) => `${actor}/statuses/${status.id}`);
  const featured: ApFeaturedCollectionJSON = {
    "@context": ACTIVITY_STREAMS,
    id: featuredCollectionUri(actor),
    type: "OrderedCollection",
    totalItems: items.length,
    orderedItems: items,
  };
  return c.json(featured, 200, jsonLd);
};

/**
 * The account's featured hashtags, as Mastodon's `CollectionsController`
 * serves `tags`. In secure mode a signed fetcher the account blocks, or whose
 * domain it blocks, reads an empty collection.
 */
export const getUsersByUsernameCollectionsTags = async (
  c: Context<{ Bindings: Env }, "/users/:username/collections/tags">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const access = await authorizeObjectFetch(c, identity.value);
  if (access.kind === "Denied") {
    return access.response;
  }
  const owner = await documentOwner(c, access, c.req.param("username"));
  if (owner.kind === "Refused") {
    return owner.response;
  }
  const { account } = owner;
  const hidden =
    access.kind === "Signed"
      ? await blocksFetcher(c.env.DB, account, access.actor.actorUri)
      : ok(false);
  if (hidden.isErr()) {
    return jsonRepositoryError(c, hidden.error.message);
  }
  const names = hidden.value ? ok([]) : await listFeaturedTags(c.env.DB, account.id);
  if (names.isErr()) {
    return jsonRepositoryError(c, names.error.message);
  }
  const actor = InstanceIdentity.actorUrl(identity.value, account.username);
  const tags: ApFeaturedTagsCollectionJSON = {
    "@context": [ACTIVITY_STREAMS, { Hashtag: "as:Hashtag" }],
    id: featuredTagsCollectionUri(actor),
    type: "Collection",
    totalItems: names.value.length,
    items: names.value.map((name) => hashtagObject(identity.value, name)),
  };
  return c.json(tags, 200, jsonLd);
};

const FORBIDDEN_DOMAIN = {
  error: "This instance does not federate with that domain",
  kind: "Forbidden",
} as const;

const handleInbox = async (c: Context<{ Bindings: Env }>, inbox: InboxTarget) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const path = c.req.path;
  const parsedSignature = parseRequestSignature(c.req.raw.headers);
  const refuse = (refusal: Omit<InboxRefusal, "path">): void =>
    recordInboxRefusal(c.env, {
      path,
      keyId: parsedSignature.map((signature) => signature.keyId).unwrapOr(undefined),
      ...refusal,
    });
  const read = await readBodyText(c.req.raw, MAX_JSON_BYTES);
  if (read.isErr()) {
    refuse({ reason: "PayloadTooLarge", status: 413 });
    return c.body(null, 413);
  }
  const bodyText = read.value;
  const json = parseJsonText(bodyText);
  if (json.isErr()) {
    refuse({ reason: "UnparseableBody", status: 400 });
    return c.json({ kind: "ValidationError" }, 400);
  }
  const activityJson = parseActivityJson(
    nameCollectionActivity(json.value, c.req.header("Date"), c.req.header("Digest")),
  );
  if (activityJson.isErr()) {
    refuse({ reason: "UnparseableBody", status: 400 });
    return c.json({ kind: "ValidationError" }, 400);
  }
  const payload = activityPayloadFromJson(activityJson.value);
  const actorUri = String(payload.actor);
  if (parsedSignature.isErr()) {
    const { kind } = parsedSignature.error;
    refuse({
      reason: "MissingSignature",
      status: 401,
      actor: actorUri,
      detail: kind === "Unsigned" ? undefined : kind,
    });
    return c.json({ kind: "InvalidSignature" }, 401);
  }
  const signature = parsedSignature.value;
  // A signature must cover `date` and `digest` (RFC 9421: `@target-uri` and
  // `content-digest`), and be recent, so a captured delivery cannot be
  // replayed (SIG-1): refused before any lookup.
  const weak = checkSignatureStrength(c.req.raw, signature);
  if (weak !== undefined) {
    refuse({
      reason: weak.kind,
      status: 401,
      actor: actorUri,
      detail: weak.kind === "SignatureExpired" ? weak.detail : undefined,
    });
    return c.json({ kind: "InvalidSignature" }, 401);
  }
  // The signature covers `Digest` (`Content-Digest`), and a body that does
  // not match it never verifies: refused before any key lookup or fetch.
  switch (await checkBodyDigest(c.req.raw, signature, bodyText)) {
    case "Match":
      break;
    case "Mismatch":
      refuse({ reason: "DigestMismatch", status: 401, actor: actorUri });
      return c.json({ kind: "InvalidSignature" }, 401);
    case "Malformed":
      refuse({ reason: "MalformedContentDigest", status: 400, actor: actorUri });
      return c.json({ kind: "InvalidSignature" }, 400);
  }
  const [suspended, allowHosts] = await Promise.all([
    suspendedDomains(c.env.DB),
    federationAllowHosts(c.env),
  ]);
  const fetchSigner = instanceActorFetchSigner(c.env.DB, identity.value);
  const actorUsername = parseLocalActorUsername(identity.value, actorUri);
  const deletesSigner =
    payload.kind === "Delete" &&
    RemoteDeleteTarget.of(actorUri, String(payload.object)).kind === "ActorDelete";
  /**
   * A refusal of `actor` (the request's signer, or the actor a forward
   * vouches for): limited federation, a suspended domain, or an actor an
   * admin suspended, whose own account `Delete` alone still counts.
   */
  const refusalOf = async (actor: RemoteActor): Promise<Response | undefined> => {
    const refusedActorHost = RemoteActor.hostnames(actor).find(
      (host) => CoveredHosts.covers(suspended, host) || !allowListAdmits(allowHosts, host),
    );
    if (refusedActorHost !== undefined) {
      refuse({
        reason: CoveredHosts.covers(suspended, refusedActorHost)
          ? "DomainSuspended"
          : "DomainNotAllowed",
        status: 403,
        actor: actorUri,
        signer: actor.actorUri,
      });
      return c.json(FORBIDDEN_DOMAIN, 403);
    }
    const [moderation, domainSuspended] = await Promise.all([
      getRemoteActorModeration(c.env.DB, actor.actorUri),
      listDomainSuspendedActors(c.env.DB, [actor.actorUri]),
    ]);
    if (moderation.isErr()) {
      return jsonRepositoryError(c, moderation.error.message);
    }
    if (domainSuspended.isErr()) {
      return jsonRepositoryError(c, domainSuspended.error.message);
    }
    // Suspended by an admin, or by a domain suspension made while it was known.
    if (
      (moderation.value.standing.kind === "Suspended" ||
        domainSuspended.value.has(actor.actorUri)) &&
      !(deletesSigner && actor.actorUri === actorUri)
    ) {
      refuse({ reason: "ActorSuspended", status: 403, actor: actorUri, signer: actor.actorUri });
      return c.json({ error: "This actor is suspended on this instance", kind: "Forbidden" }, 403);
    }
    return undefined;
  };
  // Who signed the request. The activity is that actor's, but for a forward:
  // another actor's request carrying it, whose actor signed it too.
  let requestSigner: InboxSigner;
  let signingKey: VerificationKey;
  let forwarder: RemoteActor | undefined;
  if (actorUsername) {
    const actorAccount = await findAccountByUsername(c.env.DB, actorUsername);
    if (actorAccount.isErr()) {
      return jsonRepositoryError(c, actorAccount.error.message);
    }
    if (!actorAccount.value) {
      refuse({ reason: "UnknownLocalActor", status: 401, actor: actorUri });
      return c.json({ kind: "InvalidSignature" }, 401);
    }
    requestSigner = { kind: "Local", account: actorAccount.value };
    signingKey = { kind: "Rsa", publicKeyPem: actorAccount.value.publicKeyPem };
  } else {
    // A repeated account Delete from an actor already purged: there is nothing
    // to remove and its key can no longer be fetched.
    if (deletesSigner) {
      const cached = await findRemoteActorByUri(c.env.DB, actorUri);
      if (cached.isErr()) {
        return jsonRepositoryError(c, cached.error.message);
      }
      if (!cached.value) {
        return c.body(null, 202);
      }
    }
    // A key or actor on a suspended or not-allowed host is refused before
    // anything is fetched from it (a cached actor there is refused below).
    const refusedHost = [Hostname.ofUri(signature.keyId), Hostname.ofUri(actorUri)].find(
      (host) =>
        host !== undefined &&
        (CoveredHosts.covers(suspended, host) || !allowListAdmits(allowHosts, host)),
    );
    if (refusedHost !== undefined) {
      refuse({
        reason: CoveredHosts.covers(suspended, refusedHost)
          ? "DomainSuspended"
          : "DomainNotAllowed",
        status: 403,
        actor: actorUri,
      });
      return c.json(FORBIDDEN_DOMAIN, 403);
    }
    let signatureChecked: boolean | undefined;
    const keyOwner = await resolveKeyOwner(c.env.DB, identity.value, signature.keyId, {
      allowHosts,
      blockedHosts: suspended,
      fetchSigner,
      checkSignature: async (key) => {
        signatureChecked = await verifyInboxRequest(c.req.raw, key, bodyText);
        return signatureChecked;
      },
    });
    if (keyOwner.isErr()) {
      if (keyOwner.error.kind === "VerificationUnavailable") {
        refuse({ reason: "KeyUnavailable", status: 503, actor: actorUri });
        c.header("Retry-After", "5");
        return c.json({ kind: "VerificationUnavailable" }, 503);
      }
      if (keyOwner.error.kind === "RepositoryError") {
        return jsonRepositoryError(c, keyOwner.error.message);
      }
      if (keyOwner.error.kind === "DomainRefused") {
        refuse({
          reason: CoveredHosts.covers(suspended, keyOwner.error.host)
            ? "DomainSuspended"
            : "DomainNotAllowed",
          status: 403,
          actor: actorUri,
        });
        return c.json(FORBIDDEN_DOMAIN, 403);
      }
      refuse({
        reason: signatureChecked === false ? "SignatureMismatch" : "KeyRejected",
        status: 401,
        actor: actorUri,
      });
      return c.json({ kind: "InvalidSignature" }, 401);
    }
    const { actor: signer, key } = keyOwner.value;
    const signerRefusal = await refusalOf(signer);
    if (signerRefusal !== undefined) {
      return signerRefusal;
    }
    requestSigner = { kind: "Remote", actor: signer };
    signingKey = key;
    // Another actor signed the request: a forward, which counts only once
    // the activity's actor's own signature is checked, after the request's.
    forwarder = signer.actorUri === actorUri ? undefined : signer;
  }
  const verified = await verifyInboxRequest(c.req.raw, signingKey, bodyText);
  if (!verified) {
    refuse({ reason: "SignatureMismatch", status: 401, actor: actorUri });
    return c.json({ kind: "InvalidSignature" }, 401);
  }
  const signerUri =
    requestSigner.kind === "Local"
      ? InstanceIdentity.actorUrl(identity.value, requestSigner.account.username)
      : requestSigner.actor.actorUri;
  // Counted per sending server only once its signature verified, so an
  // unsigned or forged delivery cannot spend another server's budget (the
  // per-address `inbox_ip` limit, in the middleware, comes before any of this).
  if (requestSigner.kind === "Remote") {
    const limited = await limitInboxDelivery(
      c,
      Hostname.ofUri(requestSigner.actor.actorUri) ?? requestSigner.actor.domain,
    );
    if (limited !== undefined) {
      refuse({ reason: "RateLimitedDomain", status: 429, actor: actorUri, signer: signerUri });
      return limited;
    }
    // A verified delivery from the server shows it is up, as Mastodon's
    // `DeliveryFailureTracker.track_inverse_success!`: a domain with recorded
    // delivery failures is cleared (one D1 write); one without costs nothing.
    // Only the signing actor's own host: the inbox URLs in its document are
    // whatever that server claims.
    const senderHost = Hostname.ofUri(requestSigner.actor.actorUri);
    if (senderHost !== undefined) {
      await recordDeliveryReachability(c.env, senderHost, "Reachable", "inbound");
    }
    // Before the activity is read, as Mastodon's `InboxesController#create`.
    await prepareFollowersSynchronization(
      c.env,
      identity.value,
      requestSigner.actor,
      c.req.header("Collection-Synchronization"),
    );
  }
  let author: InboxSigner = requestSigner;
  // What the handlers read: the body as received, or for a forward its
  // actor vouches for with an integrity proof, the document the proof covers.
  let processed = { received: activityJson.value, body: json.value };
  if (forwarder !== undefined) {
    // As Mastodon, the forwarder's request is answered 202 either way.
    const forward = await verifyForwardedActivity(c.env.DB, identity.value, json.value, actorUri, {
      allowHosts,
      blockedHosts: suspended,
      fetchSigner,
    });
    switch (forward.kind) {
      case "Unavailable":
        refuse({ reason: "KeyUnavailable", status: 503, actor: actorUri, signer: signerUri });
        c.header("Retry-After", "5");
        return c.json({ kind: "VerificationUnavailable" }, 503);
      case "RepositoryError":
        return jsonRepositoryError(c, forward.message);
      case "Unverified":
        refuse({
          reason: "UnverifiedForward",
          status: 202,
          actor: actorUri,
          signer: signerUri,
          detail: forward.reason,
        });
        return c.body(null, 202);
      case "Verified": {
        const authorRefusal = await refusalOf(forward.author);
        if (authorRefusal !== undefined) {
          return authorRefusal;
        }
        const received = parseActivityJson(
          nameCollectionActivity(forward.document, c.req.header("Date"), c.req.header("Digest")),
        );
        if (received.isErr()) {
          refuse({ reason: "UnparseableBody", status: 400, actor: actorUri, signer: signerUri });
          return c.json({ kind: "ValidationError" }, 400);
        }
        author = { kind: "Remote", actor: forward.author };
        processed = { received: received.value, body: forward.document };
        break;
      }
      default:
        return assertNever(forward);
    }
  }
  const activityId = ActivityId.parse(payload.id);
  if (activityId.isErr()) {
    refuse({ reason: "InvalidActivityId", status: 400, actor: actorUri, signer: signerUri });
    return c.json({ kind: "ValidationError" }, 400);
  }
  // Claimed before it is applied and marked handled only after: a failed
  // apply gives the claim back, so the sender's retry is applied, not
  // answered as a duplicate.
  const claimKey = inboxClaimKey(activityId.value, activityJson.value);
  const claim = await claimInboxActivity(c.env.DB, {
    activityId: claimKey,
    payload: activityJson.value,
  });
  if (claim.isErr()) {
    return jsonRepositoryError(c, claim.error.message);
  }
  const received = InboxActivity.dispatch(
    { kind: "Received", activityId: activityId.value, payload },
    claim.value,
  );
  if (received.kind === "Duplicate") {
    if (received.claim.kind === "Processed") {
      return c.body(null, 202);
    }
    // Another delivery is applying it. A 503 makes the sender retry, and the
    // retry is a duplicate if that apply succeeds, or applies it if not.
    refuse({ reason: "ActivityInFlight", status: 503, actor: actorUri, signer: signerUri });
    c.header("Retry-After", "60");
    return c.json({ error: "This activity is being processed", kind: "ActivityInFlight" }, 503);
  }
  if (received.kind === "Rejected") {
    refuse({
      reason: "ActivityRejected",
      status: 400,
      actor: actorUri,
      signer: signerUri,
      detail: received.error.kind,
    });
    await completeInboxActivity(c.env.DB, claimKey, received.error.kind);
    return c.json(received.error, 400);
  }
  const applied = await dispatchInbox(
    {
      route: forwarder === undefined ? { kind: "Direct" } : { kind: "Forwarded", forwarder },
      inbox,
      env: c.env,
      identity: identity.value,
      activity: received.activity,
      received: processed.received,
      body: processed.body,
      allowHosts,
      blockedHosts: suspended,
      fetchSigner,
    },
    author,
  );
  if (applied.isErr()) {
    await releaseInboxActivity(c.env.DB, claimKey);
    if (applied.error.kind === "Unavailable") {
      refuse({
        reason: "KeyUnavailable",
        status: 503,
        actor: actorUri,
        signer: signerUri,
        detail: received.activity.kind,
      });
      c.header("Retry-After", "60");
      return c.json({ kind: "VerificationUnavailable" }, 503);
    }
    return jsonRepositoryError(c, applied.error.message);
  }
  // Applied: 202 even if marking it handled fails, as a retry would apply it
  // twice. The claim then goes stale and the hourly cron releases it.
  await completeInboxActivity(c.env.DB, claimKey, received.activity.kind);
  return c.body(null, 202);
};

export const postUsersByUsernameInbox = (c: Context<{ Bindings: Env }, "/users/:username/inbox">) =>
  handleInbox(c, { kind: "Personal", username: c.req.param("username") });
export const postInbox = (c: Context<{ Bindings: Env }, "/inbox">) =>
  handleInbox(c, { kind: "Shared" });
export const postActorInbox = (c: Context<{ Bindings: Env }, "/actor/inbox">) =>
  handleInbox(c, { kind: "Shared" });

/** Mastodon's instance actor document (`GET /actor`). */
export const getActor = async (c: Context<{ Bindings: Env }, "/actor">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const keys = await instanceActorKeys(c.env.DB);
  if (keys.isErr()) {
    return jsonRepositoryError(c, keys.error.message);
  }
  return c.json(instanceActorDocument(identity.value, keys.value.publicKeyPem), 200, jsonLd);
};
