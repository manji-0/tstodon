import { FediRole, InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import {
  findAccountById,
  findAccountByIdOrUsername,
  findAccountByUsername,
  updateAccountProfile,
} from "../account-store";
import { authenticate } from "../auth";
import { enqueueTargetedActivity } from "../delivery";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  readBody,
  requireSession,
  requireUser,
} from "../http";
import {
  mastodonAccountDocument,
  mastodonRelationship,
  mastodonRemoteAccount,
  mastodonStatuses,
} from "../mastodon";
import { findRemoteActorByUri, deleteRemoteFollow, findRemoteFollow } from "../remote-actor-store";
import { RemoteAccountId } from "../remote-account-id";
import { parseInstanceIdentity } from "../runtime-config";
import {
  blockAccount,
  endorseAccount,
  familiarFollowerIds,
  followAccount,
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
import { UpdateCredentialsBodySchema } from "../schemas";

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
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, viewerId));
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
  const ids =
    kind === "followers"
      ? await listFollowers(c.env.DB, account.value.id, queryLimit(c.req.query("limit")))
      : await listFollowing(c.env.DB, account.value.id, queryLimit(c.req.query("limit")));
  if (ids.isErr()) {
    return jsonRepositoryError(c, ids.error.message);
  }
  const documents = [];
  for (const id of ids.value) {
    const found = await findAccountById(c.env.DB, id);
    if (found.isOk() && found.value) {
      documents.push(await mastodonAccountDocument(c.env, identity.value, found.value));
    }
  }
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
  const prior = await relationshipFlags(c.env.DB, user.value.id, target.value.id);
  const followed = await followAccount(
    c.env.DB,
    user.value.id,
    target.value.id,
    target.value.locked,
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
  const rows = await listBlockedAccounts(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit"), 40),
  );
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

accountRoutes.get("/api/v1/mutes", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rows = await listMutedAccounts(
    c.env.DB,
    user.value.id,
    queryLimit(c.req.query("limit"), 40),
  );
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
  const rows = await listEndorsements(c.env.DB, ownerId);
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
