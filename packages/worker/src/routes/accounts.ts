import { FediRole, InstanceIdentity, RemoteActor, Visibility } from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  findAccountById,
  findAccountByIdOrUsername,
  findAccountByUsername,
  searchAccounts,
  setAccountLocked,
  updateAccountProfile,
} from "../account-store";
import { findAccountProfile, upsertAccountProfile } from "../account-profile-store";
import { InstanceLimits } from "@tstodon/core";
import { authenticate } from "../auth";
import { attachFilteredToStatuses } from "../filter-match";
import { getAccountModeration } from "../account-moderation-store";
import { enqueueTargetedActivity } from "../delivery";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAccountsLimit,
  queryCursor,
  queryLimit,
  setPaginationLinks,
  readBody,
  readOptionalBody,
  requireSession,
  requireUser,
} from "../http";
import {
  mastodonAccountDocument,
  mastodonRelationship,
  mastodonRemoteAccount,
  mastodonStatuses,
} from "../mastodon";
import {
  findRemoteActorByUri,
  deleteRemoteFollow,
  findRemoteFollow,
  searchRemoteActors,
} from "../remote-actor-store";
import { resolveRemoteActorByHandle } from "../remote-actor-fetch";
import { suspendedDomains } from "../admin-domain-block-store";
import { federationAllowHosts } from "../runtime-config";
import { ok, err } from "neverthrow";
import { RemoteAccountId } from "../remote-account-id";
import { parseInstanceIdentity } from "../runtime-config";
import {
  blockAccount,
  endorseAccount,
  familiarFollowerIds,
  followAccount,
  followingAccountIds,
  type FollowOptions,
  listBlockedAccounts,
  listEndorsements,
  listFollowers,
  listFollowing,
  listMutedAccounts,
  muteAccount,
  relationshipFlags,
  setAccountNote,
  unblockAccount,
  unendorseAccount,
  unfollowAccount,
  unmuteAccount,
} from "../social-store";
import { notifyAccount } from "../notify";
import { listAccountStatusesFiltered, listPinnedStatuses } from "../status-store";
import { FollowBodySchema, isTruthy, stringList, UpdateCredentialsBodySchema } from "../schemas";

export const accountRoutes = new Hono<{ Bindings: Env }>();

/** Mastodon boolean query params: `true`/`1` are on, anything else is off. */
const queryFlag = (value: string | undefined): boolean => value === "true" || value === "1";

accountRoutes.get("/api/v1/accounts/verify_credentials", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const document = await mastodonAccountDocument(c.env, identity.value, session.value.account);
  return c.json({
    ...document,
    role: FediRole.toMastodon(session.value.role),
    source: {
      privacy:
        session.value.account.defaultPostVisibility.kind === "FollowersOnly" ? "private" : "public",
      sensitive: false,
      language: "",
      note: "",
      fields: [],
    },
  });
});

/** Avatar and header uploads: image types only, up to the advertised size cap. */
const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const storeProfileImage = async (
  env: Env,
  accountId: string,
  kind: "avatar" | "header",
  value: unknown,
): Promise<
  | Readonly<{ kind: "Ok"; objectKey: string | null; contentType: string | null }>
  | Readonly<{ kind: "Err"; message: string }>
> => {
  if (value === undefined || value === null) {
    return { kind: "Ok", objectKey: null, contentType: null };
  }
  if (!(value instanceof File)) {
    return { kind: "Err", message: `${kind} must be sent as a file` };
  }
  const contentType = value.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const allowed: ReadonlyArray<string> = InstanceLimits.media.supportedMimeTypes.filter((type) =>
    type.startsWith("image/"),
  );
  if (!allowed.includes(contentType)) {
    return { kind: "Err", message: `${kind} must be one of ${allowed.join(", ")}` };
  }
  const bytes = await value.arrayBuffer();
  if (bytes.byteLength > PROFILE_IMAGE_MAX_BYTES) {
    return { kind: "Err", message: `${kind} exceeds ${PROFILE_IMAGE_MAX_BYTES} bytes` };
  }
  const objectKey = `${kind}s/${accountId}`;
  await env.MEDIA.put(objectKey, bytes, { httpMetadata: { contentType } });
  return { kind: "Ok", objectKey, contentType };
};

accountRoutes.patch("/api/v1/accounts/update_credentials", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, UpdateCredentialsBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const displayName =
    body.value.display_name && body.value.display_name.trim().length > 0
      ? body.value.display_name.trim()
      : user.value.displayName;
  const updated = await updateAccountProfile(c.env.DB, user.value.id, displayName);
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }

  // Bio, profile fields, and the bot/discoverable flags live beside the row.
  const existingProfile = await findAccountProfile(c.env.DB, user.value.id);
  if (existingProfile.isErr()) {
    return jsonRepositoryError(c, existingProfile.error.message);
  }
  const fields = body.value.fields
    ?.flatMap((field) => {
      const name = field.name?.trim() ?? "";
      const value = field.value?.trim() ?? "";
      return name.length > 0 && value.length > 0 ? [{ name, value }] : [];
    })
    // Mastodon keeps only the first few profile fields.
    .slice(0, InstanceLimits.account.maxProfileFields);
  // Avatar / header uploads land in the media bucket like any other object.
  const uploaded = await storeProfileImage(c.env, user.value.id, "avatar", body.value.avatar);
  if (uploaded.kind === "Err") {
    return c.json({ error: uploaded.message, kind: "ValidationError" }, 422);
  }
  const header = await storeProfileImage(c.env, user.value.id, "header", body.value.header);
  if (header.kind === "Err") {
    return c.json({ error: header.message, kind: "ValidationError" }, 422);
  }
  const saved = await upsertAccountProfile(c.env.DB, user.value.id, {
    note: body.value.note === undefined ? existingProfile.value.note : body.value.note,
    fields: fields === undefined ? existingProfile.value.fields : fields,
    bot: body.value.bot === undefined ? existingProfile.value.bot : isTruthy(body.value.bot),
    discoverable:
      body.value.discoverable === undefined
        ? existingProfile.value.discoverable
        : isTruthy(body.value.discoverable),
    avatarObjectKey: uploaded.objectKey ?? existingProfile.value.avatarObjectKey,
    avatarContentType: uploaded.contentType ?? existingProfile.value.avatarContentType,
    headerObjectKey: header.objectKey ?? existingProfile.value.headerObjectKey,
    headerContentType: header.contentType ?? existingProfile.value.headerContentType,
  });
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  if (body.value.locked !== undefined) {
    const locked = await setAccountLocked(c.env.DB, user.value.id, isTruthy(body.value.locked));
    if (locked.isErr()) {
      return jsonRepositoryError(c, locked.error.message);
    }
  }
  const latest = await findAccountById(c.env.DB, user.value.id);
  if (latest.isErr() || !latest.value) {
    return jsonRepositoryError(c, "account missing after update");
  }
  return c.json(await mastodonAccountDocument(c.env, identity.value, latest.value));
});

accountRoutes.get("/api/v1/accounts/lookup", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const acct = (c.req.query("acct") ?? "").split("@")[0] ?? "";
  const account = await findAccountByUsername(c.env.DB, acct);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonAccountDocument(c.env, identity.value, account.value));
});

accountRoutes.get("/api/v1/accounts/relationships", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const url = new URL(c.req.url);
  const ids = [...url.searchParams.getAll("id[]"), ...url.searchParams.getAll("id")].filter(
    (id) => id.length > 0,
  );
  const relationships = [];
  for (const id of ids) {
    const flags = await relationshipFlags(c.env.DB, user.value.id, id);
    if (flags.isOk()) {
      relationships.push(mastodonRelationship(id, flags.value));
    }
  }
  return c.json(relationships);
});

/** Mastodon caps familiar followers per requested account. */
const FAMILIAR_FOLLOWERS_LIMIT = 3;

/**
 * `GET /api/v1/accounts/search`: Mastodon's account-only search. The exact
 * match for a complete `@user@domain` handle is prepended on the first page
 * (resolving it only when `resolve=true`), then local accounts and cached
 * remote actors matching the query follow. `following=true` keeps only
 * accounts the viewer follows; this instance has no record of following remote
 * actors, so remote results are dropped there.
 */
/**
 * `GET /api/v1/preferences`: the posting defaults this instance enforces
 * (`posting:default:visibility` is what an omitted visibility uses) plus
 * Mastodon's reading defaults, which are client-side settings we do not store.
 */
accountRoutes.get("/api/v1/preferences", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  return c.json({
    "posting:default:visibility": Visibility.toMastodon(user.value.defaultPostVisibility),
    "posting:default:sensitive": false,
    "posting:default:language": null,
    "reading:expand:media": "default",
    "reading:expand:spoilers": false,
    "reading:autoplay:gifs": false,
  });
});

accountRoutes.get("/api/v1/accounts/search", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rawQuery = (c.req.query("q") ?? "").trim();
  const query = rawQuery.replace(/^@/, "");
  const limit = queryAccountsLimit(c.req.query("limit"));
  const requestedOffset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
  const resolve = isTruthy(c.req.query("resolve"));
  const onlyFollowing = isTruthy(c.req.query("following"));
  if (query.length === 0) {
    return c.json([]);
  }
  const following = onlyFollowing ? await followingAccountIds(c.env.DB, user.value.id) : undefined;
  if (following?.isErr()) {
    return jsonRepositoryError(c, following.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (document: Record<string, unknown>): void => {
    const id = String(document.id);
    if (!seen.has(id)) {
      seen.add(id);
      documents.push(document);
    }
  };
  const followed = (accountId: string): boolean =>
    following === undefined || (following.isOk() && following.value.has(accountId));

  // The exact match, only on the first page and only for a complete handle.
  const handle = /^[^\s@]+@[^\s@]+$/.test(query) ? query : undefined;
  if (offset === 0 && handle) {
    const [username, domain] = handle.split("@");
    if (domain?.toLowerCase() === identity.value.domain.toLowerCase()) {
      const local = await findAccountByIdOrUsername(c.env.DB, username ?? "");
      if (local.isErr()) {
        return jsonRepositoryError(c, local.error.message);
      }
      if (local.value && followed(local.value.id)) {
        push(await mastodonAccountDocument(c.env, identity.value, local.value));
      }
    } else if (following === undefined) {
      const resolved = resolve
        ? await resolveRemoteActorByHandle(c.env.DB, identity.value, handle, {
            allowHosts: await federationAllowHosts(c.env),
            blockedHosts: await suspendedDomains(c.env.DB),
          })
        : await (async () => {
            // Without `resolve` only the actor cache is consulted.
            const cached = await searchRemoteActors(c.env.DB, handle, 1);
            const exact = cached.isOk()
              ? cached.value.find(
                  (actor) =>
                    `${actor.username}@${actor.domain}`.toLowerCase() === handle.toLowerCase(),
                )
              : undefined;
            return exact ? ok(exact) : err({ kind: "InvalidSignature" as const });
          })();
      if (resolved.isErr() && resolve && resolved.error.kind === "VerificationUnavailable") {
        // Mastodon's documented 503 for a domain that is not currently live.
        return c.json({ error: "Remote data could not be fetched" }, 503);
      }
      if (resolved.isOk()) {
        push(mastodonRemoteAccount(identity.value, resolved.value));
      }
    }
  }

  // Non-exact results: local accounts first, then cached remote actors.
  const remaining = Math.max(limit - documents.length, 0);
  const terms = handle
    ? handle.split("@")[1] === identity.value.domain
      ? (handle.split("@")[0] ?? "")
      : query
    : query;
  if (remaining > 0) {
    const local = await searchAccounts(c.env.DB, terms, remaining + offset, offset);
    if (local.isErr()) {
      return jsonRepositoryError(c, local.error.message);
    }
    for (const account of local.value) {
      if (!followed(account.id)) {
        continue;
      }
      push(await mastodonAccountDocument(c.env, identity.value, account));
      if (documents.length >= limit) {
        break;
      }
    }
  }
  if (following === undefined && documents.length < limit) {
    const remote = await searchRemoteActors(c.env.DB, query, limit + offset);
    if (remote.isErr()) {
      return jsonRepositoryError(c, remote.error.message);
    }
    for (const actor of remote.value) {
      if (documents.length >= limit) {
        break;
      }
      push(mastodonRemoteAccount(identity.value, actor));
    }
  }
  return c.json(documents.slice(0, limit));
});

accountRoutes.get("/api/v1/accounts/familiar_followers", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const url = new URL(c.req.url);
  const requestedIds = [
    ...url.searchParams.getAll("id[]"),
    ...url.searchParams.getAll("id"),
  ].filter((value) => value.length > 0);

  const groups: Record<string, unknown>[] = [];
  for (const requestedId of requestedIds) {
    const account = await findAccountByIdOrUsername(c.env.DB, requestedId);
    if (account.isErr()) {
      return jsonRepositoryError(c, account.error.message);
    }
    const accounts: Record<string, unknown>[] = [];
    if (account.value) {
      const followerIds = await familiarFollowerIds(
        c.env.DB,
        user.value.id,
        account.value.id,
        FAMILIAR_FOLLOWERS_LIMIT,
      );
      if (followerIds.isErr()) {
        return jsonRepositoryError(c, followerIds.error.message);
      }
      for (const followerId of followerIds.value) {
        const follower = await findAccountById(c.env.DB, followerId);
        if (follower.isOk() && follower.value) {
          accounts.push(await mastodonAccountDocument(c.env, identity.value, follower.value));
        }
      }
    }
    groups.push({ id: requestedId, accounts });
  }
  return c.json(groups);
});

accountRoutes.get("/api/v1/accounts/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const id = c.req.param("id") ?? "";
  const account = await findAccountByIdOrUsername(c.env.DB, id);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (account.value) {
    const moderation = await getAccountModeration(c.env.DB, account.value.id);
    if (moderation.isOk() && moderation.value === "Suspended") {
      return c.json({ error: "This account is suspended", kind: "AccountSuspended" }, 410);
    }
    return c.json(await mastodonAccountDocument(c.env, identity.value, account.value));
  }
  const actorUri = RemoteAccountId.decode(id);
  if (actorUri.isOk()) {
    const actor = await findRemoteActorByUri(c.env.DB, actorUri.value);
    if (actor.isErr()) {
      return jsonRepositoryError(c, actor.error.message);
    }
    if (actor.value) {
      return c.json(mastodonRemoteAccount(identity.value, actor.value));
    }
  }
  return c.json({ error: "Record not found", kind: "NotFound" }, 404);
});

accountRoutes.get("/api/v1/accounts/:id/statuses", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  const viewerId = auth.value.kind === "Account" ? auth.value.account.id : undefined;
  const account = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const statuses =
    c.req.query("pinned") === "true"
      ? await listPinnedStatuses(c.env.DB, account.value.id)
      : await listAccountStatusesFiltered(c.env.DB, account.value.id, {
          limit: queryLimit(c.req.query("limit")),
          excludeReplies: queryFlag(c.req.query("exclude_replies")),
          excludeReblogs: queryFlag(c.req.query("exclude_reblogs")),
          onlyMedia: queryFlag(c.req.query("only_media")),
          tagged: c.req.query("tagged"),
          cursor: {
            maxId: c.req.query("max_id"),
            sinceId: c.req.query("since_id"),
            minId: c.req.query("min_id"),
          },
        });
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(
    await attachFilteredToStatuses(
      c.env.DB,
      viewerId,
      "public",
      statuses.value,
      await mastodonStatuses(c.env, identity.value, statuses.value, viewerId),
    ),
  );
});

const accountList = async (c: Context<{ Bindings: Env }>, kind: "followers" | "following") => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  const edges =
    kind === "followers"
      ? await listFollowers(c.env.DB, account.value.id, limit, queryCursor(c))
      : await listFollowing(c.env.DB, account.value.id, limit, queryCursor(c));
  if (edges.isErr()) {
    return jsonRepositoryError(c, edges.error.message);
  }
  const documents = [];
  for (const edge of edges.value) {
    const found = await findAccountById(c.env.DB, edge.accountId);
    if (found.isOk() && found.value) {
      documents.push(await mastodonAccountDocument(c.env, identity.value, found.value));
    }
  }
  // Follow row ids are not in the documents, so the Link header carries them.
  setPaginationLinks(
    c,
    edges.value.map((edge) => edge.id),
    limit,
    { prev: "since_id" },
  );
  return c.json(documents);
};

accountRoutes.get("/api/v1/accounts/:id/followers", (c) => accountList(c, "followers"));
accountRoutes.get("/api/v1/accounts/:id/following", (c) => accountList(c, "following"));

accountRoutes.post("/api/v1/accounts/:id/follow", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.value.id === user.value.id) {
    return c.json({ error: "Cannot follow yourself", kind: "InvalidFollow" }, 400);
  }
  // Mastodon's follow options: `reblogs`, `notify`, and `languages[]`.
  const followBody = await readOptionalBody(c, FollowBodySchema);
  if (followBody.isErr()) {
    return jsonValidationError(c);
  }
  const languageValues = [
    ...(c.req.queries("languages[]") ?? []),
    ...(c.req.queries("languages") ?? []),
    ...stringList(followBody.value.languages),
  ]
    .map((language) => language.trim().toLowerCase())
    .filter((language) => /^[a-z]{2,3}(-[a-z0-9]+)?$/.test(language));
  // The options arrive as form data; query parameters are accepted too.
  const reblogsRaw = followBody.value.reblogs ?? c.req.query("reblogs");
  const notifyRaw = followBody.value.notify ?? c.req.query("notify");
  const followOptions: FollowOptions = {
    ...(reblogsRaw === undefined ? {} : { reblogs: isTruthy(reblogsRaw) }),
    ...(notifyRaw === undefined ? {} : { notify: isTruthy(notifyRaw) }),
    ...(c.req.queries("languages[]") === undefined &&
    c.req.queries("languages") === undefined &&
    followBody.value.languages === undefined
      ? {}
      : { languages: [...new Set(languageValues)] }),
  };
  const prior = await relationshipFlags(c.env.DB, user.value.id, target.value.id);
  const followed = await followAccount(
    c.env.DB,
    user.value.id,
    target.value.id,
    target.value.locked,
    followOptions,
  );
  if (followed.isErr()) {
    return jsonRepositoryError(c, followed.error.message);
  }
  const alreadyRelated = prior.isOk() && (prior.value.following || prior.value.requested);
  if (
    !alreadyRelated &&
    followed.value.kind === "LocalFollower" &&
    followed.value.follow.kind !== "None"
  ) {
    await notifyAccount(c.env, {
      accountId: target.value.id,
      fromAccountId: user.value.id,
      kind: followed.value.follow.kind === "Pending" ? "follow_request" : "follow",
    });
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, target.value.id);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(target.value.id, flags.value));
});

accountRoutes.post("/api/v1/accounts/:id/unfollow", async (c) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const unfollowed = await unfollowAccount(c.env.DB, user.value.id, target.value.id);
  if (unfollowed.isErr()) {
    return jsonRepositoryError(c, unfollowed.error.message);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, target.value.id);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(target.value.id, flags.value));
});

const MuteBodySchema = z.object({
  notifications: z.union([z.boolean(), z.string(), z.null()]).optional(),
  duration: z.union([z.number(), z.string(), z.null()]).optional(),
});

const selfTargetError = (c: Context<{ Bindings: Env }>, action: string) =>
  c.json({ error: `Cannot ${action} yourself`, kind: "InvalidRelationship" }, 400);

/** Load the viewer's relationship with a local target and respond with it. */
const respondWithRelationship = async (
  c: Context<{ Bindings: Env }>,
  viewerId: string,
  targetId: string,
): Promise<Response> => {
  const flags = await relationshipFlags(c.env.DB, viewerId, targetId);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
};

const blockOrUnblock = async (c: Context<{ Bindings: Env }>, block: boolean): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.value.id === user.value.id) {
    return selfTargetError(c, block ? "block" : "unblock");
  }
  const actorUri = InstanceIdentity.actorUrl(identity.value, target.value.username);
  const written = block
    ? await blockAccount(c.env.DB, user.value.id, target.value.id, actorUri)
    : await unblockAccount(c.env.DB, user.value.id, actorUri);
  if (written.isErr()) {
    return jsonRepositoryError(c, written.error.message);
  }
  return respondWithRelationship(c, user.value.id, target.value.id);
};

accountRoutes.post("/api/v1/accounts/:id/block", (c) => blockOrUnblock(c, true));
accountRoutes.post("/api/v1/accounts/:id/unblock", (c) => blockOrUnblock(c, false));

accountRoutes.post("/api/v1/accounts/:id/mute", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.value.id === user.value.id) {
    return selfTargetError(c, "mute");
  }
  const body = await readBody(c, MuteBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const notifications =
    body.value.notifications === undefined ||
    body.value.notifications === null ||
    body.value.notifications === true ||
    body.value.notifications === "true";
  const duration = Number(body.value.duration ?? 0);
  const expiresAt =
    Number.isFinite(duration) && duration > 0
      ? new Date(Date.now() + duration * 1000).toISOString()
      : null;
  const actorUri = InstanceIdentity.actorUrl(identity.value, target.value.username);
  const muted = await muteAccount(c.env.DB, user.value.id, target.value.id, actorUri, {
    notifications,
    expiresAt,
  });
  if (muted.isErr()) {
    return jsonRepositoryError(c, muted.error.message);
  }
  return respondWithRelationship(c, user.value.id, target.value.id);
});

accountRoutes.post("/api/v1/accounts/:id/unmute", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const target = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (target.value.id === user.value.id) {
    return selfTargetError(c, "unmute");
  }
  const actorUri = InstanceIdentity.actorUrl(identity.value, target.value.username);
  const unmuted = await unmuteAccount(c.env.DB, user.value.id, actorUri);
  if (unmuted.isErr()) {
    return jsonRepositoryError(c, unmuted.error.message);
  }
  return respondWithRelationship(c, user.value.id, target.value.id);
});

accountRoutes.get("/api/v1/blocks", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  const rows = await listBlockedAccounts(c.env.DB, user.value.id, limit, queryCursor(c));
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const documents = [];
  for (const row of rows.value) {
    const account = await findAccountById(c.env.DB, row.accountId);
    if (account.isOk() && account.value) {
      documents.push(await mastodonAccountDocument(c.env, identity.value, account.value));
    }
  }
  setPaginationLinks(
    c,
    rows.value.map((row) => row.id),
    limit,
  );
  return c.json(documents);
});

accountRoutes.get("/api/v1/mutes", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const limit = queryAccountsLimit(c.req.query("limit"));
  const rows = await listMutedAccounts(c.env.DB, user.value.id, limit, queryCursor(c));
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const documents = [];
  for (const row of rows.value) {
    const account = await findAccountById(c.env.DB, row.accountId);
    if (account.isOk() && account.value) {
      documents.push(await mastodonAccountDocument(c.env, identity.value, account.value));
    }
  }
  return c.json(documents);
});

/** Resolve an endorsement target to a local account id or a remote actor URI. */
const endorsementTarget = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  targetId: string,
): Promise<Readonly<{ accountId: string | null; actorUri: string }> | undefined> => {
  const local = await findAccountByIdOrUsername(c.env.DB, targetId);
  if (local.isOk() && local.value) {
    return {
      accountId: local.value.id,
      actorUri: InstanceIdentity.actorUrl(identity, local.value.username),
    };
  }
  const actorUri = RemoteAccountId.decode(targetId);
  if (actorUri.isOk()) {
    return { accountId: null, actorUri: actorUri.value };
  }
  return undefined;
};

const setEndorsed = async (c: Context<{ Bindings: Env }>, endorse: boolean): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const targetId = c.req.param("id") ?? "";
  const target = await endorsementTarget(c, identity.value, targetId);
  if (!target) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const changed = endorse
    ? await endorseAccount(c.env.DB, user.value.id, target)
    : await unendorseAccount(c.env.DB, user.value.id, targetId);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, targetId);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
};

accountRoutes.post("/api/v1/accounts/:id/endorse", (c) => setEndorsed(c, true));
accountRoutes.post("/api/v1/accounts/:id/unendorse", (c) => setEndorsed(c, false));

const AccountNoteBodySchema = z.object({ comment: z.string() });

accountRoutes.post("/api/v1/accounts/:id/note", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const targetId = c.req.param("id") ?? "";
  const target = await endorsementTarget(c, identity.value, targetId);
  if (!target) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const body = await readBody(c, AccountNoteBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const saved = await setAccountNote(
    c.env.DB,
    user.value.id,
    { ...target, id: targetId },
    body.value.comment,
  );
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  const flags = await relationshipFlags(c.env.DB, user.value.id, targetId);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
});

accountRoutes.post("/api/v1/accounts/:id/remove_from_followers", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const targetId = c.req.param("id") ?? "";

  const local = await findAccountByIdOrUsername(c.env.DB, targetId);
  if (local.isErr()) {
    return jsonRepositoryError(c, local.error.message);
  }
  if (local.value) {
    const removed = await unfollowAccount(c.env.DB, local.value.id, user.value.id);
    if (removed.isErr()) {
      return jsonRepositoryError(c, removed.error.message);
    }
    const flags = await relationshipFlags(c.env.DB, user.value.id, local.value.id);
    if (flags.isErr()) {
      return jsonRepositoryError(c, flags.error.message);
    }
    return c.json(mastodonRelationship(local.value.id, flags.value));
  }

  const actorUri = RemoteAccountId.decode(targetId);
  if (actorUri.isErr()) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const actor = await findRemoteActorByUri(c.env.DB, actorUri.value);
  if (actor.isErr()) {
    return jsonRepositoryError(c, actor.error.message);
  }
  if (!actor.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const existing = await findRemoteFollow(c.env.DB, user.value.id, actorUri.value);
  if (existing.isErr()) {
    return jsonRepositoryError(c, existing.error.message);
  }
  if (!existing.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const dropped = await deleteRemoteFollow(c.env.DB, actorUri.value, user.value.id);
  if (dropped.isErr()) {
    return jsonRepositoryError(c, dropped.error.message);
  }

  // Tell the remote follower it no longer follows; delivery is best effort.
  const actorUrl = InstanceIdentity.actorUrl(identity.value, user.value.username);
  const followObjectId = existing.value.followActivityId ?? actorUri.value;
  await enqueueTargetedActivity(
    c.env,
    user.value.id,
    "Reject",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorUrl}/activities/reject-${followObjectId}`,
      type: "Reject",
      actor: actorUrl,
      object: { id: followObjectId, type: "Follow", actor: actorUri.value, object: actorUrl },
    },
    RemoteActor.deliveryInbox(actor.value),
  );

  const flags = await relationshipFlags(c.env.DB, user.value.id, actorUri.value);
  if (flags.isErr()) {
    return jsonRepositoryError(c, flags.error.message);
  }
  return c.json(mastodonRelationship(targetId, flags.value));
});

const endorsementDocuments = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  ownerId: string,
): Promise<Response> => {
  const limit = queryAccountsLimit(c.req.query("limit"));
  const rows = await listEndorsements(c.env.DB, ownerId, limit, queryCursor(c));
  if (rows.isErr()) {
    return jsonRepositoryError(c, rows.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const row of rows.value) {
    if (row.accountId) {
      const account = await findAccountById(c.env.DB, row.accountId);
      if (account.isOk() && account.value) {
        documents.push(await mastodonAccountDocument(c.env, identity, account.value));
        continue;
      }
    }
    const actor = await findRemoteActorByUri(c.env.DB, row.actorUri);
    if (actor.isOk() && actor.value) {
      documents.push(mastodonRemoteAccount(identity, actor.value));
    }
  }
  setPaginationLinks(
    c,
    rows.value.map((row) => row.id),
    limit,
  );
  return c.json(documents);
};

accountRoutes.get("/api/v1/endorsements", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  return endorsementDocuments(c, identity.value, user.value.id);
});

accountRoutes.get("/api/v1/accounts/:id/endorsements", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const account = await findAccountByIdOrUsername(c.env.DB, c.req.param("id") ?? "");
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return endorsementDocuments(c, identity.value, account.value.id);
});
