import { FediRole } from "@tstodon/domain";
import { Hono } from "hono";
import type { Context } from "hono";
import {
  findAccountById,
  findAccountByIdOrUsername,
  findAccountByUsername,
  updateAccountProfile,
} from "../account-store";
import { authenticate } from "../auth";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryLimit,
  readBody,
  requireSession,
  requireUser,
} from "../http";
import { mastodonAccountDocument, mastodonRelationship, mastodonStatuses } from "../mastodon";
import { parseInstanceIdentity } from "../runtime-config";
import {
  followAccount,
  insertNotification,
  listFollowers,
  listFollowing,
  relationshipFlags,
  unfollowAccount,
} from "../social-store";
import { listAccountStatuses } from "../status-store";
import { UpdateCredentialsBodySchema } from "../schemas";

export const accountRoutes = new Hono<{ Bindings: Env }>();

accountRoutes.get("/api/v1/accounts/verify_credentials", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const document = await mastodonAccountDocument(
    c.env,
    identity.value,
    session.value.account,
  );
  return c.json({
    ...document,
    role: FediRole.toMastodon(session.value.role),
    source: {
      privacy:
        session.value.account.defaultPostVisibility.kind === "FollowersOnly"
          ? "private"
          : "public",
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
  const ids = [
    ...url.searchParams.getAll("id[]"),
    ...url.searchParams.getAll("id"),
  ].filter((id) => id.length > 0);
  const relationships = [];
  for (const id of ids) {
    const flags = await relationshipFlags(c.env.DB, user.value.id, id);
    if (flags.isOk()) {
      relationships.push(mastodonRelationship(id, flags.value));
    }
  }
  return c.json(relationships);
});

accountRoutes.get("/api/v1/accounts/:id", async (c) => {
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
  return c.json(await mastodonAccountDocument(c.env, identity.value, account.value));
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
  const statuses = await listAccountStatuses(
    c.env.DB,
    account.value.id,
    queryLimit(c.req.query("limit")),
  );
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  return c.json(await mastodonStatuses(c.env, identity.value, statuses.value, viewerId));
});

const accountList = async (
  c: Context<{ Bindings: Env }>,
  kind: "followers" | "following",
) => {
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
  const alreadyRelated =
    prior.isOk() && (prior.value.following || prior.value.requested);
  if (
    !alreadyRelated &&
    followed.value.kind === "LocalFollower" &&
    followed.value.follow.kind !== "None"
  ) {
    await insertNotification(c.env.DB, {
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
