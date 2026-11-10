import type { ApiFeaturedTagJSON, ApiHashtagJSON } from "@tstodon/api";
import { ApiCreateFeaturedTagParamsSchema } from "@tstodon/api";
import type { Context } from "hono";
import { AccountPresentation, type InstanceIdentity } from "@tstodon/domain";
import { accountRefPresentation } from "../account-presentation";
import { localRef } from "../account-ref";
import { findAccountById } from "../account-store";
import { authenticate } from "../auth";
import { jsonAuthError, jsonRepositoryError, jsonValidationError, requireUser } from "../http";
import { mastodonFeaturedTag, mastodonTag } from "../tag-documents";
import { parseInstanceIdentity } from "../runtime-config";
import { readParams } from "../request-params";
import { isTagUsable } from "../tag-moderation-store";
import {
  FEATURED_TAG_LIMIT,
  accountTagUses,
  countFeaturedTags,
  featuredTagSuggestions,
  featureTag,
  followTag,
  isTagFeatured,
  isTagFollowed,
  isValidTag,
  listFeaturedTags,
  listFollowedTags,
  normalizeTag,
  tagDailyHistories,
  tagDailyHistory,
  unfeatureTag,
  unfollowTag,
} from "../tag-store";

type DocumentResult<T> =
  | Readonly<{ kind: "Ok"; document: T }>
  | Readonly<{ kind: "Err"; message: string }>;

const tagNotFound = (c: Context<{ Bindings: Env }>): Response =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

const viewerOf = async (c: Context<{ Bindings: Env }>): Promise<string | undefined> => {
  const auth = await authenticate(c.req.raw, c.env);
  return auth.isOk() && auth.value.kind === "Account" ? auth.value.account.id : undefined;
};

const buildTagDocument = async (
  env: Env,
  identity: InstanceIdentity,
  name: string,
  viewerId: string | undefined,
  following: boolean,
): Promise<DocumentResult<ApiHashtagJSON>> => {
  const history = await tagDailyHistory(env.DB, name);
  if (history.isErr()) {
    return { kind: "Err", message: history.error.message };
  }
  const featuring = viewerId
    ? (await isTagFeatured(env.DB, viewerId, name)).unwrapOr(false)
    : false;
  return {
    kind: "Ok",
    document: mastodonTag(identity, name, { history: history.value, following, featuring }),
  };
};

const buildFeaturedTagDocument = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
  username: string,
  name: string,
): Promise<DocumentResult<ApiFeaturedTagJSON>> => {
  const uses = await accountTagUses(env.DB, accountId, name);
  if (uses.isErr()) {
    return { kind: "Err", message: uses.error.message };
  }
  return {
    kind: "Ok",
    document: mastodonFeaturedTag(
      identity,
      username,
      name,
      uses.value.count,
      uses.value.lastStatusAt,
    ),
  };
};

export const buildFeaturedTagDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
  username: string,
): Promise<
  | Readonly<{ kind: "Ok"; documents: ApiFeaturedTagJSON[] }>
  | Readonly<{ kind: "Err"; message: string }>
> => {
  const names = await listFeaturedTags(env.DB, accountId);
  if (names.isErr()) {
    return { kind: "Err", message: names.error.message };
  }
  const documents: ApiFeaturedTagJSON[] = [];
  for (const name of names.value) {
    const built = await buildFeaturedTagDocument(env, identity, accountId, username, name);
    if (built.kind === "Err") {
      return { kind: "Err", message: built.message };
    }
    documents.push(built.document);
  }
  return { kind: "Ok", documents };
};

export const getV1TagsByName = async (c: Context<{ Bindings: Env }, "/api/v1/tags/:name">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const name = normalizeTag(c.req.param("name") ?? "");
  if (!isValidTag(name)) {
    return tagNotFound(c);
  }
  const viewerId = await viewerOf(c);
  const following = viewerId
    ? (await isTagFollowed(c.env.DB, viewerId, name)).unwrapOr(false)
    : false;
  const built = await buildTagDocument(c.env, identity.value, name, viewerId, following);
  if (built.kind === "Err") {
    return jsonRepositoryError(c, built.message);
  }
  return c.json(built.document);
};

const setTagFollowed = async (
  c: Context<{ Bindings: Env }>,
  follow: boolean,
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const name = normalizeTag(c.req.param("id") ?? "");
  if (!isValidTag(name)) {
    return tagNotFound(c);
  }
  const changed = follow
    ? await followTag(c.env.DB, user.value.id, name)
    : await unfollowTag(c.env.DB, user.value.id, name);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const built = await buildTagDocument(c.env, identity.value, name, user.value.id, follow);
  if (built.kind === "Err") {
    return jsonRepositoryError(c, built.message);
  }
  return c.json(built.document);
};

export const postV1TagsByIdFollow = (c: Context<{ Bindings: Env }, "/api/v1/tags/:id/follow">) =>
  setTagFollowed(c, true);
export const postV1TagsByIdUnfollow = (
  c: Context<{ Bindings: Env }, "/api/v1/tags/:id/unfollow">,
) => setTagFollowed(c, false);

const setTagFeatured = async (
  c: Context<{ Bindings: Env }>,
  feature: boolean,
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const name = normalizeTag(c.req.param("id") ?? "");
  if (!isValidTag(name)) {
    return tagNotFound(c);
  }
  if (feature) {
    const already = await isTagFeatured(c.env.DB, user.value.id, name);
    if (already.isErr()) {
      return jsonRepositoryError(c, already.error.message);
    }
    if (!already.value) {
      const usable = await isTagUsable(c.env.DB, name);
      if (usable.isErr()) {
        return jsonRepositoryError(c, usable.error.message);
      }
      if (!usable.value) {
        return c.json({ error: "Validation failed: Tag is not usable", kind: "TagNotUsable" }, 422);
      }
      const count = await countFeaturedTags(c.env.DB, user.value.id);
      if (count.isErr()) {
        return jsonRepositoryError(c, count.error.message);
      }
      if (count.value >= FEATURED_TAG_LIMIT) {
        return c.json(
          {
            error: "You have already featured the maximum number of tags",
            kind: "FeaturedTagLimitReached",
          },
          422,
        );
      }
      const added = await featureTag(c.env.DB, user.value.id, name);
      if (added.isErr()) {
        return jsonRepositoryError(c, added.error.message);
      }
    }
  } else {
    const removed = await unfeatureTag(c.env.DB, user.value.id, name);
    if (removed.isErr()) {
      return jsonRepositoryError(c, removed.error.message);
    }
  }
  const built = await buildFeaturedTagDocument(
    c.env,
    identity.value,
    user.value.id,
    user.value.username,
    name,
  );
  if (built.kind === "Err") {
    return jsonRepositoryError(c, built.message);
  }
  return c.json(built.document);
};

export const postV1TagsByIdFeature = (c: Context<{ Bindings: Env }, "/api/v1/tags/:id/feature">) =>
  setTagFeatured(c, true);
export const postV1TagsByIdUnfeature = (
  c: Context<{ Bindings: Env }, "/api/v1/tags/:id/unfeature">,
) => setTagFeatured(c, false);

export const getV1FollowedTags = async (c: Context<{ Bindings: Env }, "/api/v1/followed_tags">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const tags = await listFollowedTags(c.env.DB, user.value.id);
  if (tags.isErr()) {
    return jsonRepositoryError(c, tags.error.message);
  }
  const [histories, featured] = await Promise.all([
    tagDailyHistories(c.env.DB, tags.value),
    listFeaturedTags(c.env.DB, user.value.id),
  ]);
  if (histories.isErr()) {
    return jsonRepositoryError(c, histories.error.message);
  }
  const featuring = new Set(featured.unwrapOr([]));
  return c.json(
    tags.value.map((name) =>
      mastodonTag(identity.value, name, {
        history: histories.value.get(name) ?? [],
        following: true,
        featuring: featuring.has(name),
      }),
    ),
  );
};

export const getV1FeaturedTags = async (c: Context<{ Bindings: Env }, "/api/v1/featured_tags">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const built = await buildFeaturedTagDocuments(
    c.env,
    identity.value,
    user.value.id,
    user.value.username,
  );
  if (built.kind === "Err") {
    return jsonRepositoryError(c, built.message);
  }
  return c.json(built.documents);
};

export const postV1FeaturedTags = async (
  c: Context<{ Bindings: Env }, "/api/v1/featured_tags">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readParams(c, ApiCreateFeaturedTagParamsSchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const name = normalizeTag(body.value.name);
  if (!isValidTag(name)) {
    return c.json({ error: "Invalid tag name", kind: "ValidationFailed" }, 422);
  }
  const already = await isTagFeatured(c.env.DB, user.value.id, name);
  if (already.isErr()) {
    return jsonRepositoryError(c, already.error.message);
  }
  if (!already.value) {
    const usable = await isTagUsable(c.env.DB, name);
    if (usable.isErr()) {
      return jsonRepositoryError(c, usable.error.message);
    }
    if (!usable.value) {
      return c.json({ error: "Validation failed: Tag is not usable", kind: "TagNotUsable" }, 422);
    }
    const count = await countFeaturedTags(c.env.DB, user.value.id);
    if (count.isErr()) {
      return jsonRepositoryError(c, count.error.message);
    }
    if (count.value >= FEATURED_TAG_LIMIT) {
      return c.json(
        {
          error: "You have already featured the maximum number of tags",
          kind: "FeaturedTagLimitReached",
        },
        422,
      );
    }
    const added = await featureTag(c.env.DB, user.value.id, name);
    if (added.isErr()) {
      return jsonRepositoryError(c, added.error.message);
    }
  }
  const built = await buildFeaturedTagDocument(
    c.env,
    identity.value,
    user.value.id,
    user.value.username,
    name,
  );
  if (built.kind === "Err") {
    return jsonRepositoryError(c, built.message);
  }
  return c.json(built.document);
};

export const deleteV1FeaturedTagsById = async (
  c: Context<{ Bindings: Env }, "/api/v1/featured_tags/:id">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const name = normalizeTag(c.req.param("id") ?? "");
  if (!isValidTag(name)) {
    return tagNotFound(c);
  }
  const removed = await unfeatureTag(c.env.DB, user.value.id, name);
  if (removed.isErr()) {
    return jsonRepositoryError(c, removed.error.message);
  }
  if (!removed.value) {
    return tagNotFound(c);
  }
  return c.json({});
};

export const getV1FeaturedTagsSuggestions = async (
  c: Context<{ Bindings: Env }, "/api/v1/featured_tags/suggestions">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const suggestions = await featuredTagSuggestions(c.env.DB, user.value.id, FEATURED_TAG_LIMIT);
  if (suggestions.isErr()) {
    return jsonRepositoryError(c, suggestions.error.message);
  }
  return c.json(
    suggestions.value.map((name) => mastodonTag(identity.value, name, { history: [] })),
  );
};

export const getV1AccountsByIdFeaturedTags = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/:id/featured_tags">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountById(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return tagNotFound(c);
  }
  const presentation = await accountRefPresentation(c.env, localRef(identity.value, account.value));
  if (presentation.isErr()) {
    return jsonRepositoryError(c, presentation.error.message);
  }
  if (!AccountPresentation.available(presentation.value)) {
    return c.json([]);
  }
  const built = await buildFeaturedTagDocuments(
    c.env,
    identity.value,
    account.value.id,
    account.value.username,
  );
  if (built.kind === "Err") {
    return jsonRepositoryError(c, built.message);
  }
  return c.json(built.documents);
};
