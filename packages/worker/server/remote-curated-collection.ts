import { normalizeHashtag } from "@tstodon/core";
import {
  Hostname,
  type InstanceIdentity,
  OutboxJob,
  RemoteCollection,
  type RemoteActor,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { findAccountById, findAccountByUsername } from "./account-store";
import { parseLocalActorUsername } from "./activitypub";
import { refId } from "./activitypub-wire";
import { suspendedDomains } from "./admin-domain-block-store";
import { nowIso } from "./clock";
import { featureAuthorizationDocument } from "./collection-documents";
import { type RepositoryError, toRepositoryError } from "./d1";
import {
  fetchActivityJson,
  type FederatedFetchError,
  type FederatedFetchOptions,
} from "./federated-fetch";
import { newEntityId } from "./ids";
import { instanceActorFetchSigner } from "./instance-actor";
import { queueOutboxJobs } from "./queue-jobs";
import { resolveRemoteActor } from "./remote-actor-fetch";
import { fetchCollectionPage, firstCollectionPage } from "./remote-collection";
import {
  acceptRemoteItem,
  deleteRemoteItemsExcept,
  findRemoteCollection,
  findRemoteCollectionByUri,
  findRemoteItemRow,
  listRemoteItemRows,
  type RemoteCollectionFields,
  saveRemoteItem,
  setRemoteItemState,
  upsertRemoteCollection,
} from "./remote-curated-collection-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

const field = (json: unknown, key: string): unknown =>
  typeof json === "object" && json !== null ? Reflect.get(json, key) : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const sameHost = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined &&
  b !== undefined &&
  Hostname.ofUri(a) !== undefined &&
  Hostname.ofUri(a) === Hostname.ofUri(b);

/** Ruby's `text[0, limit]`: the first `limit` characters. */
const truncated = (value: string, limit: number): string =>
  Array.from(value).slice(0, limit).join("");

/** `url_to_href(json['url'], 'text/html')`, or the id when there is none usable. */
const htmlUrl = (json: unknown, id: string): string => {
  const raw: unknown = field(json, "url");
  const links: ReadonlyArray<unknown> = Array.isArray(raw) ? raw : [raw];
  const html: unknown = links.find(
    (link) => typeof link === "object" && link !== null && field(link, "mediaType") === "text/html",
  );
  const url =
    refId(html ?? links[0]) ?? (typeof html === "object" ? text(field(html, "href")) : undefined);
  return url !== undefined && /^https?:\/\//i.test(url) ? url : id;
};

/**
 * `ProcessFeaturedCollectionService#collection_attributes`, or none for a
 * document `update!` would refuse (no boolean `sensitive` / `discoverable`).
 */
const collectionFields = (
  actor: RemoteActor,
  json: unknown,
  id: string,
): RemoteCollectionFields | undefined => {
  const sensitive: unknown = field(json, "sensitive");
  const discoverable: unknown = field(json, "discoverable");
  if (typeof sensitive !== "boolean" || typeof discoverable !== "boolean") {
    return undefined;
  }
  const summaryMap: unknown = field(json, "summaryMap");
  const mapEntries =
    typeof summaryMap === "object" && summaryMap !== null ? Object.entries(summaryMap) : [];
  const [firstEntry] = mapEntries;
  const summary = text(firstEntry?.[1]) ?? text(field(json, "summary")) ?? "";
  const totalItems: unknown = field(json, "totalItems");
  const topicName = text(field(field(json, "topic"), "name"));
  const tagName = topicName === undefined ? "" : normalizeHashtag(topicName);
  return {
    actorUri: actor.actorUri,
    uri: id,
    url: htmlUrl(json, id),
    name: truncated(text(field(json, "name")) ?? "", RemoteCollection.nameLimit),
    descriptionHtml: truncated(summary, RemoteCollection.descriptionLimit),
    language: firstEntry?.[0] ?? null,
    sensitive,
    discoverable,
    originalNumberOfItems:
      typeof totalItems === "number" && Number.isInteger(totalItems) && totalItems >= 0
        ? totalItems
        : 0,
    tagName: tagName === "" ? null : tagName,
  };
};

/** The authorization an item names, as its server answers for it. */
type Authorization =
  | Readonly<{ kind: "Served"; document: unknown }>
  | Readonly<{ kind: "NotServed" }>
  | Readonly<{ kind: "Unavailable" }>;

/** The account and item ids this server's `ap_account_feature_authorization_url` names. */
const localAuthorizationPath = (
  identity: InstanceIdentity,
  uri: string,
): Readonly<{ accountId: string; itemId: string }> | undefined => {
  const prefix = `${identity.publicOrigin.replace(/\/$/, "")}/ap/users/`;
  const [accountId, segment, itemId, ...rest] = uri.startsWith(prefix)
    ? uri.slice(prefix.length).split("/")
    : [];
  return accountId && segment === "feature_authorizations" && itemId && rest.length === 0
    ? { accountId, itemId }
    : undefined;
};

const TEMPORARY_STATUSES: ReadonlySet<number> = new Set([401, 408, 429]);

/**
 * Whether a failed fetch is worth trying again, as `raise_on_error:
 * :temporary` raises: no answer, or an answer `response_error_unsalvageable?`
 * does not give up on (a 5xx but 501, a 401, a 408 or a 429).
 */
const salvageable = (error: FederatedFetchError): boolean =>
  error.status === undefined
    ? error.kind === "VerificationUnavailable"
    : error.status >= 500
      ? error.status !== 501
      : TEMPORARY_STATUSES.has(error.status);


/**
 * `fetch_resource(approval_uri, raise_on_error: :temporary)`: this server's
 * own authorization as it serves it, another server's fetched. A document
 * with another id is none, and a server that cannot be reached is
 * `Unavailable`.
 */
const fetchAuthorization = async (
  env: Env,
  identity: InstanceIdentity,
  approvalUri: string,
  options: FederatedFetchOptions,
): Promise<Authorization> => {
  if (sameHost(approvalUri, identity.publicOrigin)) {
    const path = localAuthorizationPath(identity, approvalUri);
    if (path === undefined) {
      return { kind: "NotServed" };
    }
    const account = await findAccountById(env.DB, path.accountId);
    if (account.isErr()) {
      return { kind: "Unavailable" };
    }
    if (account.value === undefined) {
      return { kind: "NotServed" };
    }
    const document = await featureAuthorizationDocument(
      env.DB,
      identity,
      account.value,
      path.itemId,
    );
    if (document.isErr()) {
      return { kind: "Unavailable" };
    }
    return document.value === undefined
      ? { kind: "NotServed" }
      : { kind: "Served", document: document.value };
  }
  const fetched = await fetchActivityJson(identity, approvalUri, options);
  if (fetched.isErr()) {
    return salvageable(fetched.error) ? { kind: "Unavailable" } : { kind: "NotServed" };
  }
  return refId(fetched.value) === approvalUri
    ? { kind: "Served", document: fetched.value }
    : { kind: "NotServed" };
};

/** Whose an item is: a local account's (`accountId`) or a remote actor's (`actorUri`). */
type ItemAccount = Readonly<{ accountId: string | null; actorUri: string | null }>;

/**
 * What `VerifyFeaturedItemService` found: the authorization is not served
 * (`Rejected`); it does not name the item, or its account cannot be found
 * (`Unverified`, nothing changes); it could not be read (`Unavailable`, try
 * again later); or it names this collection and the featured account.
 */
type Verification =
  | Readonly<{ kind: "Rejected" }>
  | Readonly<{ kind: "Unverified" }>
  | Readonly<{ kind: "Unavailable" }>
  | Readonly<{ kind: "Verified"; account: ItemAccount }>;

/**
 * `VerifyFeaturedItemService`: the authorization names the collection at
 * `collectionUri` and the account `objectUri`, on the account's host, and
 * the account resolves, local or remote.
 */
const verifyAuthorization = async (
  env: Env,
  identity: InstanceIdentity,
  options: FederatedFetchOptions,
  item: Readonly<{ collectionUri: string; objectUri: string; approvalUri: string }>,
): Promise<Verification> => {
  const authorization = await fetchAuthorization(env, identity, item.approvalUri, options);
  if (authorization.kind !== "Served") {
    return { kind: authorization.kind === "NotServed" ? "Rejected" : "Unavailable" };
  }
  const { document } = authorization;
  const type: unknown = field(document, "type");
  const types = Array.isArray(type) ? type : [type];
  if (
    !sameHost(item.approvalUri, refId(field(document, "interactionTarget"))) ||
    !types.includes("FeatureAuthorization") ||
    refId(field(document, "interactingObject")) !== item.collectionUri ||
    refId(field(document, "interactionTarget")) !== item.objectUri
  ) {
    return { kind: "Unverified" };
  }
  const localName = parseLocalActorUsername(identity, item.objectUri);
  if (localName !== undefined) {
    const local = await findAccountByUsername(env.DB, localName);
    if (local.isErr()) {
      return { kind: "Unavailable" };
    }
    return local.value === undefined
      ? { kind: "Unverified" }
      : { kind: "Verified", account: { accountId: local.value.id, actorUri: null } };
  }
  const actor = await resolveRemoteActor(env.DB, identity, item.objectUri, options);
  return actor.isOk()
    ? { kind: "Verified", account: { accountId: null, actorUri: actor.value.actorUri } }
    : { kind: "Unverified" };
};

/** Write what `verification` found of the item `itemId`. */
const applyVerification = async (
  db: D1Database,
  itemId: string,
  approvalUri: string,
  verification: Exclude<Verification, { kind: "Unavailable" }>,
): Promise<Result<void, RepositoryError>> => {
  switch (verification.kind) {
    case "Rejected":
      return setRemoteItemState(db, itemId, "rejected", nowIso());
    case "Unverified":
      return ok(undefined);
    case "Verified":
      return acceptRemoteItem(db, itemId, verification.account, approvalUri, nowIso());
  }
};

/** `VerifyFeaturedItemWorker`'s `retry: 5`. */
const VERIFY_ATTEMPTS = 5;

/**
 * Seconds before check `attempt` of an authorization: a random moment of
 * `ProcessFeaturedItemService::PROCESSING_DELAY` (30 s to 10 min) for the
 * first, then Sidekiq's backoff (`count ** 4 + 15 + rand(10 * (count + 1))`).
 */
const verifyDelaySeconds = (attempt: number, random: number): number =>
  attempt === 1
    ? Math.round(30 + random * (600 - 30))
    : (attempt - 1) ** 4 + 15 + Math.floor(random * 10 * attempt);

/** Queue check `attempt` of the authorization of the item `itemId`, after its delay. */
const queueVerification = async (
  env: Env,
  itemId: string,
  approvalUri: string,
  attempt: number,
): Promise<Result<void, RepositoryError>> => {
  const job = OutboxJob.parse({ kind: "VerifyFeaturedItem", itemId, approvalUri, attempt });
  if (job.isErr()) {
    return ok(undefined);
  }
  try {
    await env.PULL_QUEUE.send(job.value, {
      delaySeconds: verifyDelaySeconds(attempt, Math.random()),
    });
    return ok(undefined);
  } catch (cause) {
    return err(
      toRepositoryError(
        `queueing the item check failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    );
  }
};

/** The fetch options a collection job runs with: the instance actor signs. */
const jobFetchOptions = async (
  env: Env,
  identity: InstanceIdentity,
): Promise<FederatedFetchOptions> => ({
  allowHosts: await federationAllowHosts(env),
  blockedHosts: await suspendedDomains(env.DB),
  fetchSigner: instanceActorFetchSigner(env.DB, identity),
});

const stateOf = (state: string): "pending" | "accepted" | "rejected" | "revoked" =>
  state === "accepted" || state === "rejected" || state === "revoked" ? state : "pending";

type ProcessFeaturedItem = Extract<OutboxJob, { kind: "ProcessFeaturedItem" }>;
type VerifyFeaturedItem = Extract<OutboxJob, { kind: "VerifyFeaturedItem" }>;

/**
 * `ProcessFeaturedItemWorker`: one item of a stored remote collection, its
 * document embedded or fetched. The item is found by its id, or is the
 * local account's accepted `FeatureRequest` it names, or is new while the
 * collection holds fewer than 150; it takes the item's id, featured account
 * and position. Unless a local account accepted it already, its
 * authorization is checked, and checked again later when it cannot be read
 * now. A server that cannot be reached for the item retries the job.
 */
export const processFeaturedItemJob = async (
  env: Env,
  job: ProcessFeaturedItem,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const collection = await findRemoteCollection(env.DB, job.collectionId);
  if (collection.isErr()) {
    return "retry";
  }
  if (collection.value === undefined) {
    return "ok";
  }
  const options = await jobFetchOptions(env, identity.value);
  const fetched =
    typeof job.item === "string"
      ? await fetchActivityJson(identity.value, job.item, options)
      : ok(job.item);
  if (fetched.isErr()) {
    return fetched.error.kind === "VerificationUnavailable" ? "retry" : "ok";
  }
  const json = fetched.value;
  const collectionUri = collection.value.uri;
  const id = text(field(json, "id"));
  const objectUri = refId(field(json, "featuredObject"));
  const approvalUri = refId(field(json, "featureAuthorization"));
  if (id === undefined || objectUri === undefined || !sameHost(collectionUri, id)) {
    return "ok";
  }
  const localName = parseLocalActorUsername(identity.value, objectUri);
  if (localName === undefined && !sameHost(objectUri, approvalUri)) {
    return "ok";
  }
  const local =
    localName === undefined ? ok(undefined) : await findAccountByUsername(env.DB, localName);
  const rows = await listRemoteItemRows(env.DB, job.collectionId);
  if (local.isErr() || rows.isErr()) {
    return "retry";
  }
  const localAccount = local.value;
  const existing =
    rows.value.find((row) => row.uri === id) ??
    (localAccount === undefined
      ? undefined
      : rows.value.find(
          (row) =>
            row.uri === null && row.account_id === localAccount.id && row.state === "accepted",
        ));
  if (existing === undefined && rows.value.length >= RemoteCollection.itemsLimit) {
    return "ok";
  }
  const at = nowIso();
  const published = text(field(json, "published"));
  const itemId = existing?.id ?? newEntityId();
  const saved = await saveRemoteItem(
    env.DB,
    {
      id: itemId,
      collectionId: job.collectionId,
      uri: id,
      objectUri,
      // `CollectionItem#set_position`: an item added on its own goes last.
      position:
        job.position ??
        existing?.position ??
        Math.max(0, ...rows.value.map((row) => row.position)) + 1,
      createdAt:
        existing?.created_at ??
        (published && !Number.isNaN(Date.parse(published))
          ? new Date(published).toISOString()
          : at),
      state: stateOf(existing?.state ?? "pending"),
      accountId: existing?.account_id ?? null,
      actorUri: existing?.actor_uri ?? null,
      activityUri: existing?.activity_uri ?? null,
      approvalUri: existing?.approval_uri ?? null,
    },
    at,
  );
  if (saved.isErr()) {
    return "retry";
  }
  // `verify_authorization! unless @collection_item&.account&.local?`
  if ((existing?.account_id ?? null) !== null || approvalUri === undefined) {
    return "ok";
  }
  const verification = await verifyAuthorization(env, identity.value, options, {
    collectionUri,
    objectUri,
    approvalUri,
  });
  const written =
    verification.kind === "Unavailable"
      ? await queueVerification(env, itemId, approvalUri, 1)
      : await applyVerification(env.DB, itemId, approvalUri, verification);
  return written.isOk() ? "ok" : "retry";
};

/**
 * `VerifyFeaturedItemWorker`: check the authorization of a stored item
 * again, and once more later while its server cannot be reached, up to
 * {@link VERIFY_ATTEMPTS} checks.
 */
export const verifyFeaturedItemJob = async (
  env: Env,
  job: VerifyFeaturedItem,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const found = await findRemoteItemRow(env.DB, job.itemId);
  if (found.isErr()) {
    return "retry";
  }
  if (found.value === undefined || found.value.item.object_uri === null) {
    return "ok";
  }
  const verification = await verifyAuthorization(
    env,
    identity.value,
    await jobFetchOptions(env, identity.value),
    {
      collectionUri: found.value.collectionUri,
      objectUri: found.value.item.object_uri,
      approvalUri: job.approvalUri,
    },
  );
  const written =
    verification.kind !== "Unavailable"
      ? await applyVerification(env.DB, job.itemId, job.approvalUri, verification)
      : job.attempt < VERIFY_ATTEMPTS
        ? await queueVerification(env, job.itemId, job.approvalUri, job.attempt + 1)
        : ok(undefined);
  return written.isOk() ? "ok" : "retry";
};

/**
 * Embedded items larger than this are not queued: a queue message holds at
 * most 128 KB, and a `FeaturedItem` is a few hundred bytes.
 */
const MAX_EMBEDDED_ITEM_BYTES = 16 * 1024;

/** The job of one item, at `position` (none for an item added on its own). */
const itemJob = (
  collectionId: string,
  item: unknown,
  position: number | undefined,
): OutboxJob | undefined => {
  if (typeof item !== "string" && JSON.stringify(item ?? null).length > MAX_EMBEDDED_ITEM_BYTES) {
    return undefined;
  }
  const job = OutboxJob.parse({
    kind: "ProcessFeaturedItem",
    collectionId,
    item,
    ...(position === undefined ? {} : { position }),
  });
  return job.isOk() ? job.value : undefined;
};

/**
 * `ActivityPub::ProcessFeaturedCollectionService`: a collection `actor`
 * federated, stored or updated, its items not in the document dropped, and
 * a job queued for each of the first 150 (`ProcessFeaturedItemWorker`). A
 * document from another host, or attributed to another actor, is ignored.
 */
export const processRemoteCollection = async (
  env: Env,
  actor: RemoteActor,
  json: unknown,
): Promise<Result<RemoteCollection | undefined, RepositoryError>> => {
  const id = text(field(json, "id"));
  if (
    id === undefined ||
    !sameHost(actor.actorUri, id) ||
    field(json, "attributedTo") !== actor.actorUri
  ) {
    return ok(undefined);
  }
  const fields = collectionFields(actor, json, id);
  if (fields === undefined) {
    return ok(undefined);
  }
  const stored = await upsertRemoteCollection(env.DB, fields, nowIso());
  if (stored.isErr()) {
    return err(stored.error);
  }
  const orderedItems: unknown = field(json, "orderedItems");
  const items = (Array.isArray(orderedItems) ? orderedItems : []).slice(
    0,
    RemoteCollection.itemsLimit,
  );
  const kept = await deleteRemoteItemsExcept(
    env.DB,
    stored.value.id,
    items.flatMap((item) => refId(item) ?? []),
  );
  if (kept.isErr()) {
    return err(kept.error);
  }
  const queued = await queueOutboxJobs(
    env,
    items.flatMap((item, index) => itemJob(stored.value.id, item, index + 1) ?? []),
    env.PULL_QUEUE,
  );
  if (queued.isErr()) {
    return err(queued.error);
  }
  return findRemoteCollection(env.DB, stored.value.id);
};

/**
 * `FetchRemoteFeaturedCollectionService`: the collection at `uri`, stored
 * already or fetched and processed for its author, who must be `owner`.
 */
export const fetchRemoteCollection = async (
  env: Env,
  identity: InstanceIdentity,
  owner: RemoteActor,
  uri: string,
  options: FederatedFetchOptions,
): Promise<Result<RemoteCollection | undefined, RepositoryError>> => {
  const known = await findRemoteCollectionByUri(env.DB, uri);
  if (known.isErr() || known.value !== undefined) {
    return known.map((found) => (found?.actorUri === owner.actorUri ? found : undefined));
  }
  const fetched = await fetchActivityJson(identity, uri, options);
  if (fetched.isErr() || field(fetched.value, "type") !== "FeaturedCollection") {
    return ok(undefined);
  }
  return processRemoteCollection(env, owner, fetched.value);
};

/**
 * `Add#add_collection_item`: one item added to a stored collection of the
 * actor, processed by its job as a collection's items are.
 */
export const addRemoteCollectionItem = async (
  env: Env,
  collection: RemoteCollection,
  raw: unknown,
): Promise<Result<void, RepositoryError>> => {
  const job = itemJob(collection.id, raw, undefined);
  return job === undefined ? ok(undefined) : queueOutboxJobs(env, [job], env.PULL_QUEUE);
};

/** `FetchFeaturedCollectionsCollectionService::MAX_PAGES` and `MAX_ITEMS`. */
const SYNCHRONIZE_PAGES = 10;
const SYNCHRONIZE_ITEMS = 50;

/**
 * `FetchFeaturedCollectionsCollectionService`: the actor's
 * `featuredCollections`, up to ten pages and fifty collections, each embedded
 * one processed and each one named by URI fetched.
 */
export const synchronizeRemoteCollections = async (
  env: Env,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
): Promise<void> => {
  const uri = actor.profile.featuredCollectionsUri;
  if (uri === undefined) {
    return;
  }
  const items: unknown[] = [];
  let page = await firstCollectionPage(identity, uri, options);
  for (let read = 1; page !== undefined && items.length < SYNCHRONIZE_ITEMS; read += 1) {
    items.push(...page.items);
    page =
      page.next === undefined || read >= SYNCHRONIZE_PAGES
        ? undefined
        : await fetchCollectionPage(identity, page.next, options);
  }
  for (const item of items.slice(0, SYNCHRONIZE_ITEMS)) {
    if (typeof item === "string") {
      await fetchRemoteCollection(env, identity, actor, item, options);
    } else {
      await processRemoteCollection(env, actor, item);
    }
  }
};
