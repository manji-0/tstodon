import type { Context } from "hono";
import {
  rotateAccountKey,
  rotateInstanceActorKey,
  startRotateAllActorKeys,
} from "../../actor-key-rotation";
import { jsonAuthError, jsonRepositoryError, requireAdmin } from "../../http";
import { parseInstanceIdentity } from "../../runtime-config";

/**
 * Actor key rotation (OPS-8; tstodon's own, Mastodon has none): an admin
 * rotates one local account's key, the instance actor's, or every local key
 * (a background job). See `actor-key-rotation.ts` and the runbook's key
 * compromise playbook.
 */

const requested = (target: string, adminAccountId: string, accountId?: string): void =>
  console.log(
    JSON.stringify({
      kind: "ActorKeyRotationRequested",
      target,
      ...(accountId === undefined ? {} : { accountId }),
      adminAccountId,
    }),
  );

/**
 * `POST /api/v1/admin/accounts/:id/rotate_key`: a new key pair for a local
 * account, and an actor `Update` to its followers. Answers when it was
 * rotated and what became of the `Update` (`queued`, `skipped` for a
 * suspended account, or `failed`).
 */
export const postV1AdminAccountsByIdRotateKey = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/accounts/:id/rotate_key">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const accountId = c.req.param("id");
  requested("Account", admin.value.account.id, accountId);
  const rotated = await rotateAccountKey(c.env, identity.value, accountId);
  if (rotated.isErr()) {
    return rotated.error.kind === "NotFound"
      ? c.json({ error: "Record not found", kind: "NotFound" }, 404)
      : jsonRepositoryError(c, rotated.error.message);
  }
  return c.json({
    account_id: rotated.value.accountId,
    rotated_at: rotated.value.rotatedAt,
    update: rotated.value.update.toLowerCase(),
  });
};

/** `POST /api/v1/admin/actor_keys/instance_actor`: a new key pair for the instance actor. */
export const postV1AdminActorKeysInstanceActor = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/actor_keys/instance_actor">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  requested("InstanceActor", admin.value.account.id);
  const rotated = await rotateInstanceActorKey(c.env.DB);
  return rotated.isErr()
    ? jsonRepositoryError(c, rotated.error.message)
    : c.json({ rotated_at: rotated.value });
};

/**
 * `POST /api/v1/admin/actor_keys/rotate_all`: queue the bulk rotation of the
 * instance actor's key and every local account's (`RotateActorKeys`), and
 * answer 202 with when it started.
 */
export const postV1AdminActorKeysRotateAll = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/actor_keys/rotate_all">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  requested("All", admin.value.account.id);
  const started = await startRotateAllActorKeys(c.env);
  if (started.isErr()) {
    c.header("Retry-After", "5");
    return c.json({ error: started.error.message, kind: started.error.kind }, 503);
  }
  return c.json({ started_at: started.value.startedAt }, 202);
};
