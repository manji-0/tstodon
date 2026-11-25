import {
  ApiAddCollectionItemParamsSchema,
  ApiCreateCollectionParamsSchema,
  type ApiCollectionJSON,
  ApiUpdateCollectionParamsSchema,
} from "@tstodon/api";
import { isHashtagName, SupportedLocales, warmSchemas } from "@tstodon/core";
import {
  Collection,
  CollectionItem,
  type CollectionFields,
  type CollectionValidationError,
  InstanceIdentity,
  type LocalAccount,
  type RemoteActor,
  type RemoteCollection,
} from "@tstodon/domain";
import type { Context } from "hono";
import { findAccountById } from "../account-store";
import { accountDocumentsByIds } from "../account-documents";
import { findAccountProfile } from "../account-profile-store";
import { authenticate } from "../auth";
import { findBlock } from "../block-mute-store";
import { nowIso } from "../clock";
import {
  collectionViewer,
  featureAuthorizationContext,
  featureAuthorizationUri,
  mastodonCollection,
} from "../collection-documents";
import { enqueueTargetedActivity } from "../delivery";
import { deliveredActivity } from "../own-activity-signature";
import { findRemoteBlock } from "../remote-block-store";
import {
  countRemoteCollectionsOf,
  findRemoteCollection,
  listRemoteCollectionsFeaturing,
  listRemoteCollectionsOf,
  setRemoteItemState,
} from "../remote-curated-collection-store";
import { federateCollection } from "../collection-federation";
import { notifyAddedToCollection, notifyCollectionUpdate } from "../collection-notify";
import {
  countAccountCollections,
  countFeaturedInCollections,
  deleteCollection,
  deleteCollectionItem,
  findCollection,
  findRemoteStanding,
  findTag,
  insertCollection,
  insertCollectionItem,
  listAccountCollections,
  listFeaturedInCollections,
  setCollectionItemState,
  updateCollection,
} from "../collection-store";
import { findFollowKind } from "../follow-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  limitParam,
  rackQueryParam,
  requireFunctionalUser,
  rubyToI,
} from "../http";
import { newEntityId } from "../ids";
import { RemoteAccountId } from "../remote-account-id";
import { findRemoteActorByUri } from "../remote-actor-store";
import { readMergedParams } from "../request-params";
import { parseInstanceIdentity } from "../runtime-config";

warmSchemas([
  ApiCreateCollectionParamsSchema,
  ApiUpdateCollectionParamsSchema,
  ApiAddCollectionItemParamsSchema,
]);

type AnyContext = Context<{ Bindings: Env }>;

/** `Api::V1::CollectionsController`'s `DEFAULT_COLLECTIONS_LIMIT` and `MAX_COLLECTIONS_LIMIT`. */
const COLLECTIONS_PAGE = { default: 40, max: 100 } as const;
/** `limit_param(DEFAULT_COLLECTIONS_LIMIT)`, as the `Link` paths and `in_collections` read it. */
const LINK_PAGE = { default: 40, max: 80 } as const;

/** `deprecate_api '2026-06-10'`: `@` and the date's Unix time. */
const ALPHA_DEPRECATION = `@${Date.UTC(2026, 5, 10) / 1000}`;

const notFound = (c: AnyContext) => c.json({ error: "Record not found", kind: "NotFound" }, 404);
const notAllowed = (c: AnyContext) =>
  c.json({ error: "This action is not allowed", kind: "Forbidden" }, 403);

/**
 * The `{ error: { error, details } }` the collections controller renders for
 * a record that does not validate (`ValidationErrorFormatter`).
 */
const validationFailed = (
  c: AnyContext,
  errors: ReadonlyArray<
    Readonly<{ attribute: string; error: string; message: string; full: string }>
  >,
) => {
  const details: Record<string, Array<{ error: string; description: string }>> = {};
  for (const entry of errors) {
    details[entry.attribute] = [
      ...(details[entry.attribute] ?? []),
      { error: `ERR_${entry.error.toUpperCase()}`, description: entry.message },
    ];
  }
  return c.json(
    {
      error: {
        error: `Validation failed: ${errors.map((entry) => entry.full).join(", ")}`,
        details,
      },
    },
    422,
  );
};

const collectionErrors = (errors: ReadonlyArray<CollectionValidationError>) =>
  errors.map((entry) => ({ ...entry, full: Collection.fullMessage(entry) }));

/** The signed-in account, if any, as `authorize_if_got_token!` reads it. */
const optionalViewer = async (
  c: AnyContext,
): Promise<Readonly<{ kind: "Viewer"; id: string | undefined }> | Response> => {
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  return { kind: "Viewer", id: auth.value.kind === "Account" ? auth.value.account.id : undefined };
};

/**
 * `Account.without_requested_deletion.find`: a local account, or a known
 * remote one by its `r_…` id.
 */
type FoundAccount =
  | Readonly<{ kind: "Local"; id: string; discoverable: boolean; locked: boolean }>
  | Readonly<{ kind: "Remote"; id: string; actor: RemoteActor }>;

const findAccount = async (
  c: AnyContext,
  id: string,
): Promise<FoundAccount | undefined | Response> => {
  const local = await findAccountById(c.env.DB, id);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (local.value) {
    const profile = await findAccountProfile(c.env.DB, local.value.id);
    if (profile.isErr()) {
      return jsonRepositoryError(c, profile.error.message);
    }
    return {
      kind: "Local",
      id: local.value.id,
      discoverable: profile.value.discoverable,
      locked: local.value.locked,
    };
  }
  const actorUri = RemoteAccountId.decode(id);
  if (actorUri.isErr()) {
    return undefined;
  }
  const remote = await findRemoteActorByUri(c.env.DB, actorUri.value);
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  return remote.value ? { kind: "Remote", id, actor: remote.value } : undefined;
};

/**
 * `AccountPolicy#feature?` of `target` by `ownerId`: a local account's
 * flags, or the `canFeature` policy a remote account federated.
 */
const mayFeature = async (
  c: AnyContext,
  ownerId: string,
  target: FoundAccount,
): Promise<boolean | Response> => {
  if (target.kind === "Remote") {
    const standing = await findRemoteStanding(c.env.DB, ownerId, target.actor.actorUri);
    if (standing.isErr()) {
      return jsonRepositoryError(c, standing.error.message);
    }
    return Collection.featureable({
      kind: "Remote",
      policy: target.actor.profile.featurePolicy,
      ...standing.value,
    });
  }
  const [follow, blocking, blockedBy] = await Promise.all([
    findFollowKind(c.env.DB, ownerId, target.id),
    findBlock(c.env.DB, ownerId, target.id),
    findBlock(c.env.DB, target.id, ownerId),
  ]);
  if (follow.isErr()) {
    return jsonRepositoryError(c, follow.error.message);
  }
  if (blocking.isErr()) {
    return jsonRepositoryError(c, blocking.error.message);
  }
  if (blockedBy.isErr()) {
    return jsonRepositoryError(c, blockedBy.error.message);
  }
  return Collection.featureable({
    kind: "Local",
    ownerId,
    targetId: target.id,
    targetDiscoverable: target.discoverable,
    targetLocked: target.locked,
    ownerFollowsTarget: follow.value === "Accepted",
    blockedEitherWay: blocking.value || blockedBy.value,
  });
};

/**
 * `Tag`'s validations of a tag `tag_name=` would create: the name present
 * and a hashtag's, and so its display name (the same text, case kept).
 */
const newTagErrors = (name: string) => [
  ...(name === ""
    ? [
        {
          attribute: "name",
          error: "blank",
          message: "can't be blank",
          full: "Name can't be blank",
        },
      ]
    : []),
  ...(isHashtagName(name)
    ? []
    : [
        { attribute: "name", error: "invalid", message: "is invalid", full: "Name is invalid" },
        {
          attribute: "display_name",
          error: "invalid",
          message: "is invalid",
          full: "Display name is invalid",
        },
      ]),
];

/**
 * `tag_name=` (`Tag.find_or_create_by_names`): no topic for a blank param, a
 * stored tag as it is, and a new one only when its name validates.
 */
type TopicLookup =
  | Readonly<{ kind: "Topic"; tagName: string | null; usable: boolean }>
  | Readonly<{ kind: "Invalid"; response: Response }>;

const resolveTopic = async (c: AnyContext, raw: string | null): Promise<TopicLookup> => {
  if (raw === null) {
    return { kind: "Topic", tagName: null, usable: true };
  }
  const tag = await findTag(c.env.DB, raw);
  if (tag.isErr()) {
    return { kind: "Invalid", response: jsonRepositoryError(c, tag.error.message) };
  }
  if (tag.value.kind === "Stored") {
    return { kind: "Topic", tagName: tag.value.name, usable: tag.value.usable };
  }
  const errors = newTagErrors(tag.value.name);
  return errors.length > 0
    ? { kind: "Invalid", response: validationFailed(c, errors) }
    : { kind: "Topic", tagName: tag.value.name, usable: true };
};

const renderCollection = async (
  c: AnyContext,
  identity: InstanceIdentity,
  collection: Collection,
  viewerId: string,
): Promise<Response> => {
  const viewer = await collectionViewer(c.env.DB, viewerId, [collection]);
  return viewer.isErr()
    ? jsonRepositoryError(c, viewer.error.message)
    : c.json({ collection: mastodonCollection(identity, collection, viewer.value) });
};

const pageLink = (c: AnyContext, path: string, offset: number): string => {
  const url = new URL(path, c.req.url);
  const limit = rackQueryParam(c.req.url, "limit");
  if (limit !== undefined) {
    url.searchParams.set("limit", limit);
  }
  url.searchParams.set("offset", String(offset));
  return url.toString();
};

/**
 * The `Link` of the offset-paged collection lists: `next` while
 * `records_continue?` (which multiplies the offset by the limit, as Mastodon
 * 4.7.5 does), `prev` past the first offset.
 */
const setCollectionLinks = (
  c: AnyContext,
  path: string,
  page: Readonly<{ offset: number; shown: number; total: number }>,
): void => {
  const limit = limitParam(rackQueryParam(c.req.url, "limit"), LINK_PAGE);
  const links = [
    ...(page.offset * limit + page.shown < page.total
      ? [`<${pageLink(c, path, page.offset + limit)}>; rel="next"`]
      : []),
    ...(page.offset !== 0 ? [`<${pageLink(c, path, page.offset - limit)}>; rel="prev"`] : []),
  ];
  if (links.length > 0) {
    c.header("Link", links.join(", "));
  }
};

const queryOffsetParam = (c: AnyContext): number => rubyToI(c.req.query("offset") ?? "");

/** `GET /api/v1/accounts/:id/collections`. */
const accountCollections = async (c: AnyContext, accountId: string): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const viewer = await optionalViewer(c);
  if (viewer instanceof Response) {
    return viewer;
  }
  const account = await findAccount(c, accountId);
  if (account instanceof Response) {
    return account;
  }
  if (!account) {
    return notFound(c);
  }
  const offset = queryOffsetParam(c);
  const limit = limitParam(rackQueryParam(c.req.url, "limit"), COLLECTIONS_PAGE);
  const path = `/api/v1/accounts/${encodeURIComponent(accountId)}/collections`;
  if (account.kind === "Remote") {
    const [remote, remoteTotal] = await Promise.all([
      listRemoteCollectionsOf(
        c.env.DB,
        account.actor.actorUri,
        { offset: Math.max(offset, 0), limit },
        false,
      ),
      countRemoteCollectionsOf(c.env.DB, account.actor.actorUri),
    ]);
    if (remote.isErr()) {
      return jsonRepositoryError(c, remote.error.message);
    }
    if (remoteTotal.isErr()) {
      return jsonRepositoryError(c, remoteTotal.error.message);
    }
    setCollectionLinks(c, path, {
      offset,
      shown: remote.value.length,
      total: remoteTotal.value,
    });
    return renderCollections(c, identity.value, remote.value, viewer.id);
  }
  const [collections, total, blocked] = await Promise.all([
    listAccountCollections(
      c.env.DB,
      account.id,
      { offset: Math.max(offset, 0), limit },
      viewer.id === account.id,
    ),
    countAccountCollections(c.env.DB, account.id),
    viewer.id === undefined ? undefined : findBlock(c.env.DB, account.id, viewer.id),
  ]);
  if (collections.isErr()) {
    return jsonRepositoryError(c, collections.error.message);
  }
  if (total.isErr()) {
    return jsonRepositoryError(c, total.error.message);
  }
  if (blocked?.isErr()) {
    return jsonRepositoryError(c, blocked.error.message);
  }
  setCollectionLinks(c, path, { offset, shown: collections.value.length, total: total.value });
  // `index_collections?`: an owner that blocks the viewer shows it none.
  if (blocked?.isOk() && blocked.value) {
    return c.json({ collections: [] });
  }
  return renderCollections(c, identity.value, collections.value, viewer.id);
};

const renderCollections = async (
  c: AnyContext,
  identity: InstanceIdentity,
  collections: ReadonlyArray<Collection | RemoteCollection>,
  viewerId: string | undefined,
): Promise<Response> => {
  const viewer = await collectionViewer(c.env.DB, viewerId, collections);
  if (viewer.isErr()) {
    return jsonRepositoryError(c, viewer.error.message);
  }
  const documents: ApiCollectionJSON[] = collections.map((collection) =>
    mastodonCollection(identity, collection, viewer.value),
  );
  return c.json({ collections: documents });
};

export const getV1AccountsByIdCollections = (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/collections">,
) => accountCollections(c, c.req.param("id"));

export const getV1AlphaAccountsByIdCollections = (
  c: Context<{ Bindings: Env }, "/api/v1_alpha/accounts/:id/collections">,
) => accountCollections(c, c.req.param("id"));

/** `GET /api/v1/accounts/:id/in_collections`: only the account itself may list them. */
const featuredInCollections = async (c: AnyContext, accountId: string): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const viewer = await optionalViewer(c);
  if (viewer instanceof Response) {
    return viewer;
  }
  if (viewer.id === undefined) {
    return c.json({ error: "This method requires an authenticated user" }, 422);
  }
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const account = await findAccount(c, accountId);
  if (account instanceof Response) {
    return account;
  }
  if (!account) {
    return notFound(c);
  }
  const offset = queryOffsetParam(c);
  const limit = limitParam(rackQueryParam(c.req.url, "limit"), LINK_PAGE);
  const start = Math.max(offset, 0);
  const [local, localTotal, remote] = await Promise.all([
    listFeaturedInCollections(c.env.DB, account.id, { offset: start, limit }),
    countFeaturedInCollections(c.env.DB, account.id),
    listRemoteCollectionsFeaturing(c.env.DB, account.id),
  ]);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (localTotal.isErr()) {
    return jsonRepositoryError(c, localTotal.error.message);
  }
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  // `index_featured_in_collections?` refuses before the `Link` is set.
  if (account.id !== viewer.id) {
    return notAllowed(c);
  }
  // The local collections, then the remote ones, as one list paged by `offset`.
  const remoteStart = Math.max(start - localTotal.value, 0);
  const collections = [
    ...local.value,
    ...remote.value.slice(remoteStart, remoteStart + limit - local.value.length),
  ];
  setCollectionLinks(c, `/api/v1/accounts/${encodeURIComponent(accountId)}/in_collections`, {
    offset,
    shown: collections.length,
    total: localTotal.value + remote.value.length,
  });
  return renderCollections(c, identity.value, collections, viewer.id);
};

export const getV1AccountsByIdInCollections = (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/in_collections">,
) => featuredInCollections(c, c.req.param("id"));

export const getV1AlphaAccountsByIdInCollections = (
  c: Context<{ Bindings: Env }, "/api/v1_alpha/accounts/:id/in_collections">,
) => featuredInCollections(c, c.req.param("id"));

/** A local collection by id, or else a remote one. */
const findAnyCollection = async (
  c: AnyContext,
  id: string,
): Promise<Collection | RemoteCollection | undefined | Response> => {
  const local = await findCollection(c.env.DB, id);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (local.value) {
    return local.value;
  }
  const remote = await findRemoteCollection(c.env.DB, id);
  return remote.isErr() ? jsonRepositoryError(c, remote.error.message) : remote.value;
};

/** `GET /api/v1/collections/:id`: the collection and its accounts, the owner first. */
const showCollection = async (c: AnyContext, id: string): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const viewer = await optionalViewer(c);
  if (viewer instanceof Response) {
    return viewer;
  }
  const found = await findAnyCollection(c, id);
  if (found instanceof Response) {
    return found;
  }
  if (!found) {
    return notFound(c);
  }
  const collection = found;
  if (viewer.id !== undefined) {
    // `CollectionPolicy#show?`: the owner, local or remote, blocks the viewer.
    const blocked =
      collection.kind === "LocalCollection"
        ? await findBlock(c.env.DB, collection.accountId, viewer.id)
        : await findRemoteBlock(c.env.DB, collection.actorUri, viewer.id);
    if (blocked.isErr()) {
      return jsonRepositoryError(c, blocked.error.message);
    }
    if (blocked.value) {
      return notAllowed(c);
    }
  }
  const seen = await collectionViewer(c.env.DB, viewer.id, [collection]);
  if (seen.isErr()) {
    return jsonRepositoryError(c, seen.error.message);
  }
  const accountIds = [
    collection.accountId,
    ...Collection.itemsFor(collection, seen.value.id, seen.value.blocking).map(
      (item) => item.accountId,
    ),
  ];
  const accounts = await accountDocumentsByIds(c.env, identity.value, accountIds);
  if (accounts.isErr()) {
    return jsonRepositoryError(c, accounts.error.message);
  }
  return c.json({
    collection: mastodonCollection(identity.value, collection, seen.value),
    accounts: accountIds.flatMap((accountId) => accounts.value.get(accountId) ?? []),
  });
};

/** `POST /api/v1/collections`. */
const createCollection = async (c: AnyContext): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const owner = user.value;
  const params = await readMergedParams(c, ApiCreateCollectionParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const targets: FoundAccount[] = [];
  for (const accountId of params.value.account_ids ?? []) {
    const target = await findAccount(c, accountId);
    if (target instanceof Response) {
      return target;
    }
    if (!target) {
      return notFound(c);
    }
    targets.push(target);
  }
  const topic = await resolveTopic(c, params.value.tag_name ?? null);
  if (topic.kind === "Invalid") {
    return topic.response;
  }
  for (const target of targets) {
    const allowed = await mayFeature(c, owner.id, target);
    if (allowed instanceof Response) {
      return allowed;
    }
    if (!allowed) {
      return notAllowed(c);
    }
  }
  const owned = await countAccountCollections(c.env.DB, owner.id);
  if (owned.isErr()) {
    return jsonRepositoryError(c, owned.error.message);
  }
  const fields: CollectionFields = {
    name: params.value.name ?? null,
    description: params.value.description ?? null,
    language: params.value.language ?? null,
    sensitive: params.value.sensitive ?? null,
    discoverable: params.value.discoverable ?? null,
    tagName: topic.tagName,
  };
  const errors = Collection.validate(fields, {
    tagUsable: topic.usable,
    liveItemCount: targets.length,
    knownLanguage: (code) => SupportedLocales.has(code),
    ownerQuota: { count: owned.value, limit: Collection.limit },
  });
  if (errors.length > 0) {
    return validationFailed(c, collectionErrors(errors));
  }
  if (new Set(targets.map((target) => target.id)).size !== targets.length) {
    return c.json({ error: "Duplicate record" }, 422);
  }
  const now = nowIso();
  const parsed = Collection.parse({
    kind: "LocalCollection",
    id: newEntityId(),
    accountId: owner.id,
    name: fields.name,
    description: fields.description,
    language: fields.language,
    sensitive: fields.sensitive,
    discoverable: fields.discoverable,
    tagName: fields.tagName,
    createdAt: now,
    updatedAt: now,
    items: targets.map((target, index) => ({
      id: newEntityId(),
      accountId: target.id,
      position: index + 1,
      createdAt: now,
      ...itemStart(identity.value, owner, target),
    })),
  });
  if (parsed.isErr()) {
    return jsonValidationError(c);
  }
  const collection = parsed.value;
  const stored = await insertCollection(c.env.DB, collection);
  if (stored.isErr()) {
    return jsonRepositoryError(c, stored.error.message);
  }
  await Promise.all(
    collection.items
      .filter((item) => item.state === "accepted")
      .map((item) => notifyAddedToCollection(c.env, collection, item.id, item.accountId)),
  );
  await federateCollection(c.env, owner, { kind: "Created", collection });
  for (const item of collection.items.filter((candidate) => candidate.activityUri)) {
    await federateCollection(c.env, owner, { kind: "FeatureRequested", collection, item });
  }
  return renderCollection(c, identity.value, collection, owner.id);
};

export const postV1Collections = (c: Context<{ Bindings: Env }, "/api/v1/collections">) =>
  createCollection(c);

/** The caller's own collection by id: 404 when there is none, 403 when it is someone else's. */
const ownedCollection = async (
  c: AnyContext,
  id: string,
  ownerId: string,
): Promise<Collection | Response> => {
  const found = await findCollection(c.env.DB, id);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  return found.value.accountId === ownerId ? found.value : notAllowed(c);
};

/** `PUT /api/v1/collections/:id`: the fields given change; the items stay. */
const changeCollection = async (c: AnyContext, id: string): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const found = await findCollection(c.env.DB, id);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const before = found.value;
  if (before.accountId !== user.value.id) {
    return notAllowed(c);
  }
  const params = await readMergedParams(c, ApiUpdateCollectionParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const given = params.value;
  const topic =
    given.tag_name === undefined
      ? ({ kind: "Topic", tagName: before.tagName, usable: true } as const)
      : await resolveTopic(c, given.tag_name);
  if (topic.kind === "Invalid") {
    return topic.response;
  }
  const fields: CollectionFields = {
    name: given.name === undefined ? before.name : given.name,
    description: given.description === undefined ? before.description : given.description,
    language: given.language === undefined ? before.language : given.language,
    sensitive: given.sensitive === undefined ? before.sensitive : given.sensitive,
    discoverable: given.discoverable === undefined ? before.discoverable : given.discoverable,
    tagName: topic.tagName,
  };
  const errors = Collection.validate(fields, {
    tagUsable: topic.usable,
    liveItemCount: before.items.filter(Collection.live).length,
    knownLanguage: (code) => SupportedLocales.has(code),
    ownerQuota: undefined,
  });
  if (errors.length > 0) {
    return validationFailed(c, collectionErrors(errors));
  }
  const changed =
    fields.name !== before.name ||
    fields.description !== before.description ||
    fields.language !== before.language ||
    fields.sensitive !== before.sensitive ||
    fields.discoverable !== before.discoverable ||
    fields.tagName !== before.tagName;
  if (!changed) {
    return renderCollection(c, identity.value, before, user.value.id);
  }
  const after = Collection.parse({ ...before, ...fields, updatedAt: nowIso() });
  if (after.isErr()) {
    return jsonValidationError(c);
  }
  const saved = await updateCollection(c.env.DB, after.value);
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  if (Collection.significantlyChanged(before, after.value)) {
    await notifyCollectionUpdate(c.env, after.value);
  }
  await federateCollection(c.env, user.value, { kind: "Updated", collection: after.value });
  return renderCollection(c, identity.value, after.value, user.value.id);
};

/** `DELETE /api/v1/collections/:id`. */
const destroyCollection = async (c: AnyContext, id: string): Promise<Response> => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const collection = await ownedCollection(c, id, user.value.id);
  if (collection instanceof Response) {
    return collection;
  }
  const deleted = await deleteCollection(c.env.DB, collection.id);
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  await federateCollection(c.env, user.value, { kind: "Deleted", collection });
  return c.body(null, 200);
};

export const getV1CollectionsById = (c: Context<{ Bindings: Env }, "/api/v1/collections/:id">) =>
  showCollection(c, c.req.param("id"));
export const putV1CollectionsById = (c: Context<{ Bindings: Env }, "/api/v1/collections/:id">) =>
  changeCollection(c, c.req.param("id"));
export const deleteV1CollectionsById = (c: Context<{ Bindings: Env }, "/api/v1/collections/:id">) =>
  destroyCollection(c, c.req.param("id"));

/**
 * A new item's state: a local account is `accepted` at once, a remote one
 * `pending` on the `FeatureRequest` sent for it, whose id
 * `CollectionItem#set_activity_uri` makes under the owner's actor.
 */
const itemStart = (
  identity: InstanceIdentity,
  owner: LocalAccount,
  target: FoundAccount,
): Readonly<{ state: "accepted" }> | Readonly<{ state: "pending"; activityUri: string }> =>
  target.kind === "Local"
    ? { state: "accepted" }
    : {
        state: "pending",
        activityUri: `${InstanceIdentity.actorUrl(identity, owner.username)}/feature_requests/${crypto.randomUUID()}`,
      };

/** `POST /api/v1/collections/:id/items`: feature one more account. */
const addItem = async (c: AnyContext, collectionId: string): Promise<Response> => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const found = await findCollection(c.env.DB, collectionId);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return notFound(c);
  }
  const collection = found.value;
  const params = await readMergedParams(c, ApiAddCollectionItemParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const accountId = params.value.account_id ?? "";
  if (accountId.trim() === "") {
    return c.json({ error: "`account_id` parameter is missing" }, 422);
  }
  const target = await findAccount(c, accountId);
  if (target instanceof Response) {
    return target;
  }
  if (!target) {
    return notFound(c);
  }
  if (collection.accountId !== user.value.id) {
    return notAllowed(c);
  }
  const allowed = await mayFeature(c, user.value.id, target);
  if (allowed instanceof Response) {
    return allowed;
  }
  if (!allowed) {
    return notAllowed(c);
  }
  const createdAt = nowIso();
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const item = {
    id: newEntityId(),
    accountId: target.id,
    createdAt,
    ...itemStart(identity.value, user.value, target),
  };
  const inserted = await insertCollectionItem(c.env.DB, collection.id, item);
  if (inserted.isErr()) {
    return inserted.error.kind === "AlreadyFeatured"
      ? c.json({ error: "Validation failed: Account has already been taken" }, 422)
      : jsonRepositoryError(c, inserted.error.message);
  }
  const added = CollectionItem.parse({ ...item, position: inserted.value });
  if (target.kind === "Local") {
    await notifyAddedToCollection(c.env, collection, item.id, item.accountId);
  }
  if (added.isOk()) {
    await federateCollection(c.env, user.value, {
      kind: target.kind === "Local" ? "ItemAdded" : "FeatureRequested",
      collection,
      item: added.value,
    });
  }
  return c.json({
    collection_item: {
      id: item.id,
      state: item.state,
      created_at: createdAt,
      account_id: item.accountId,
    },
  });
};

/** The item of the collection, or the response for a collection or item that is not there. */
const findItem = async (
  c: AnyContext,
  collectionId: string,
  itemId: string,
): Promise<Readonly<{ collection: Collection; item: Collection["items"][number] }> | Response> => {
  const found = await findCollection(c.env.DB, collectionId);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  const item = found.value?.items.find((candidate) => candidate.id === itemId);
  return found.value && item ? { collection: found.value, item } : notFound(c);
};

/** `DELETE /api/v1/collections/:id/items/:item_id`: the owner takes an account out. */
const removeItem = async (c: AnyContext, collectionId: string, itemId: string) => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const found = await findItem(c, collectionId, itemId);
  if (found instanceof Response) {
    return found;
  }
  if (found.collection.accountId !== user.value.id) {
    return notAllowed(c);
  }
  const deleted = await deleteCollectionItem(c.env.DB, found.item.id);
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  await federateCollection(c.env, user.value, { kind: "ItemRemoved", ...found });
  return c.body(null, 200);
};

/**
 * `RevokeCollectionItemService` of a local account's item in a remote
 * collection: revoked, and the `Delete` of its authorization, signed by the
 * account, sent to the owner's inbox.
 */
const revokeRemoteItem = async (
  c: AnyContext,
  collection: RemoteCollection,
  itemId: string,
  featured: LocalAccount,
): Promise<Response> => {
  const item = collection.items.find((candidate) => candidate.id === itemId);
  if (!item) {
    return notFound(c);
  }
  if (item.accountId !== featured.id) {
    return notAllowed(c);
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const revoked = await setRemoteItemState(c.env.DB, item.id, "revoked", nowIso());
  if (revoked.isErr()) {
    return jsonRepositoryError(c, revoked.error.message);
  }
  const owner = await findRemoteActorByUri(c.env.DB, collection.actorUri);
  if (owner.isOk() && owner.value) {
    const actor = InstanceIdentity.actorUrl(identity.value, featured.username);
    const authorization = featureAuthorizationUri(identity.value, featured.id, item.id);
    const activity = await deliveredActivity(c.env, featured, {
      "@context": featureAuthorizationContext,
      id: `${authorization}#delete`,
      type: "Delete",
      actor,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: authorization,
        type: "FeatureAuthorization",
        interactingObject: collection.uri,
        interactionTarget: actor,
      },
    });
    await enqueueTargetedActivity(c.env, featured, "Delete", activity, owner.value.inboxUri);
  }
  return c.body(null, 200);
};

/** `POST /api/v1/collections/:id/items/:item_id/revoke`: the featured account opts out. */
const revokeItem = async (c: AnyContext, collectionId: string, itemId: string) => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const remote = await findRemoteCollection(c.env.DB, collectionId);
  if (remote.isErr()) {
    return jsonRepositoryError(c, remote.error.message);
  }
  if (remote.value) {
    return revokeRemoteItem(c, remote.value, itemId, user.value);
  }
  const found = await findItem(c, collectionId, itemId);
  if (found instanceof Response) {
    return found;
  }
  if (found.item.accountId !== user.value.id) {
    return notAllowed(c);
  }
  const revoked = await setCollectionItemState(c.env.DB, found.item.id, "revoked", nowIso());
  if (revoked.isErr()) {
    return jsonRepositoryError(c, revoked.error.message);
  }
  const owner = await findAccountById(c.env.DB, found.collection.accountId);
  if (owner.isOk() && owner.value) {
    await federateCollection(c.env, owner.value, {
      kind: "ItemRevoked",
      ...found,
      featured: user.value,
    });
  }
  return c.body(null, 200);
};

export const postV1CollectionsByIdItems = (
  c: Context<{ Bindings: Env }, "/api/v1/collections/:id/items">,
) => addItem(c, c.req.param("id"));
export const deleteV1CollectionsByIdItemsByItemId = (
  c: Context<{ Bindings: Env }, "/api/v1/collections/:id/items/:item_id">,
) => removeItem(c, c.req.param("id"), c.req.param("item_id"));
export const postV1CollectionsByIdItemsByItemIdRevoke = (
  c: Context<{ Bindings: Env }, "/api/v1/collections/:id/items/:item_id/revoke">,
) => revokeItem(c, c.req.param("id"), c.req.param("item_id"));

/** The `v1_alpha` paths Mastodon 4.7.5 still routes, marked deprecated. */
const deprecated =
  <P extends string>(handler: (c: Context<{ Bindings: Env }, P>) => Promise<Response>) =>
  async (c: Context<{ Bindings: Env }, P>): Promise<Response> => {
    const response = await handler(c);
    response.headers.set("Deprecation", ALPHA_DEPRECATION);
    return response;
  };

export const postV1AlphaCollections = deprecated(
  (c: Context<{ Bindings: Env }, "/api/v1_alpha/collections">) => createCollection(c),
);
export const getV1AlphaCollectionsById = deprecated(
  (c: Context<{ Bindings: Env }, "/api/v1_alpha/collections/:id">) =>
    showCollection(c, c.req.param("id")),
);
export const putV1AlphaCollectionsById = deprecated(
  (c: Context<{ Bindings: Env }, "/api/v1_alpha/collections/:id">) =>
    changeCollection(c, c.req.param("id")),
);
export const deleteV1AlphaCollectionsById = deprecated(
  (c: Context<{ Bindings: Env }, "/api/v1_alpha/collections/:id">) =>
    destroyCollection(c, c.req.param("id")),
);
export const postV1AlphaCollectionsByIdItems = deprecated(
  (c: Context<{ Bindings: Env }, "/api/v1_alpha/collections/:id/items">) =>
    addItem(c, c.req.param("id")),
);
export const deleteV1AlphaCollectionsByIdItemsByItemId = deprecated(
  (c: Context<{ Bindings: Env }, "/api/v1_alpha/collections/:id/items/:item_id">) =>
    removeItem(c, c.req.param("id"), c.req.param("item_id")),
);
export const postV1AlphaCollectionsByIdItemsByItemIdRevoke = deprecated(
  (c: Context<{ Bindings: Env }, "/api/v1_alpha/collections/:id/items/:item_id/revoke">) =>
    revokeItem(c, c.req.param("id"), c.req.param("item_id")),
);
