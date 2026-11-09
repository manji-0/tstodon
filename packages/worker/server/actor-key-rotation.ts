import { IsoInstant, type InstanceIdentity, type OutboxJob } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountStanding } from "./account-moderation-store";
import { findAccountById } from "./account-store";
import { nowIso } from "./clock";
import { type RepositoryError, runD1 } from "./d1";
import {
  listAccountsDueKeyRotation as listAccountsDueKeyRotationSql,
  rotateAccountKeys as rotateAccountKeysSql,
} from "./generated/prisma/sql";
import { instanceActorKeyDates, rotateInstanceActorKeys } from "./instance-actor";
import { generateAccountKeys } from "./keys";
import { sendActorUpdate } from "./local-actor";
import { queryTyped } from "./typed-sql";

/**
 * Actor key rotation (OPS-8). Mastodon has no rotation of its own; its keys
 * are one RSA pair per actor, published as `<actor>#main-key`. A rotation
 * here replaces the pair in place under the same key id:
 *
 * - The old private key is dropped at once (no grace period): a rotation is
 *   for a key that leaked, and remote servers only ever see the one key an
 *   actor document publishes, so keeping the old one would serve nobody.
 * - Every delivery attempt (`attemptInboxDeliveryWithEvidence`, in the
 *   delivery Workflow) and every signed fetch reads the key when it signs, so
 *   deliveries queued before the rotation go out signed with the new key.
 * - A remote server that cached the old key fails to verify the next
 *   signature and fetches the actor again (Mastodon does this once per failed
 *   verification), which picks up the new key. For a local account the
 *   followers' servers are also sent an actor `Update` carrying the new key,
 *   so they refresh before that.
 */

/** What became of the actor `Update` a rotation sends. */
export type ActorUpdateOutcome = "Queued" | "Skipped" | "Failed";

export type AccountKeyRotation = Readonly<{
  accountId: string;
  rotatedAt: string;
  update: ActorUpdateOutcome;
}>;

export type RotateAccountKeyError = RepositoryError | Readonly<{ kind: "NotFound" }>;

const IdRow = z.object({ id: z.string() });

/**
 * Replace a local account's key pair and tell its followers with an actor
 * `Update`. A suspended account sends none (its document shows nothing to
 * refresh); an `Update` that cannot be queued is logged and does not undo
 * the rotation, as remotes still refetch the actor when a signature fails.
 */
export const rotateAccountKey = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
  rotatedAt: string = nowIso(),
): Promise<Result<AccountKeyRotation, RotateAccountKeyError>> => {
  const generated = await generateAccountKeys();
  const stored = await runD1(() =>
    queryTyped(
      env.DB,
      rotateAccountKeysSql(
        accountId,
        generated.publicKeyPem,
        generated.privateKeyJwk.reveal(),
        rotatedAt,
      ),
      IdRow,
    ),
  );
  if (stored.isErr()) {
    return err(stored.error);
  }
  if (stored.value.length === 0) {
    return err({ kind: "NotFound" });
  }
  const update = await sendRotatedActorUpdate(env, identity, accountId);
  console.log(JSON.stringify({ kind: "ActorKeyRotated", actor: "Account", accountId, update }));
  return ok({ accountId, rotatedAt, update });
};

const sendRotatedActorUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
): Promise<ActorUpdateOutcome> => {
  const [account, standing] = await Promise.all([
    findAccountById(env.DB, accountId),
    findAccountStanding(env.DB, accountId),
  ]);
  if (account.isErr() || standing.isErr() || account.value === undefined) {
    return "Failed";
  }
  if (standing.value.kind === "Suspended") {
    return "Skipped";
  }
  const sent = await sendActorUpdate(env, identity, account.value);
  if (sent.isErr()) {
    console.error(
      JSON.stringify({ kind: "ActorKeyUpdateNotQueued", accountId, error: sent.error.kind }),
    );
    return "Failed";
  }
  return "Queued";
};

/** Rotate the instance actor's key pair; resolves to when. See {@link rotateInstanceActorKeys}. */
export const rotateInstanceActorKey = async (
  db: D1Database,
): Promise<Result<string, RepositoryError>> => {
  const rotated = await rotateInstanceActorKeys(db);
  if (rotated.isOk()) {
    console.log(JSON.stringify({ kind: "ActorKeyRotated", actor: "InstanceActor" }));
  }
  return rotated;
};

/** Accounts per page of `RotateActorKeys`: a key pair and an `Update` each. */
export const ROTATE_ACTOR_KEYS_PAGE = 20;

/**
 * Seconds between two pages of `RotateActorKeys`: with
 * {@link ROTATE_ACTOR_KEYS_PAGE}, at most 60 actor `Update`s a minute reach
 * any one remote server.
 */
export const ROTATE_ACTOR_KEYS_PAUSE_SECONDS = 20;

type RotateActorKeysJob = Extract<OutboxJob, { kind: "RotateActorKeys" }>;

/** The first page of a bulk rotation of every local key, started now. */
export const startRotateAllActorKeys = async (
  env: Env,
): Promise<Result<RotateActorKeysJob, Readonly<{ kind: "QueueSendFailed"; message: string }>>> => {
  const startedAt = IsoInstant.parse(nowIso());
  if (startedAt.isErr()) {
    return err({ kind: "QueueSendFailed", message: "invalid clock" });
  }
  const job: RotateActorKeysJob = {
    kind: "RotateActorKeys",
    startedAt: startedAt.value,
    afterId: "",
    rotated: 0,
  };
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job);
  } catch (cause) {
    return err({
      kind: "QueueSendFailed",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
  console.log(JSON.stringify({ kind: "ActorKeysRotationStarted", startedAt: job.startedAt }));
  return ok(job);
};

export type RotateActorKeysPage = Readonly<{
  /** Accounts rotated on this page. */
  rotated: number;
  /** The next page, when this one was full. */
  next: RotateActorKeysJob | undefined;
}>;

/**
 * One page of `RotateActorKeys`: the instance actor first (unless it was
 * rotated since the job started), then the next accounts not rotated since
 * it started, so a retried page skips the accounts it already did. The
 * caller queues `next` after {@link ROTATE_ACTOR_KEYS_PAUSE_SECONDS}.
 */
export const rotateActorKeysPage = async (
  env: Env,
  identity: InstanceIdentity,
  job: RotateActorKeysJob,
  pageSize: number = ROTATE_ACTOR_KEYS_PAGE,
): Promise<Result<RotateActorKeysPage, RepositoryError>> => {
  if (job.afterId === "") {
    const dates = await instanceActorKeyDates(env.DB);
    if (dates.isErr()) {
      return err(dates.error);
    }
    const rotatedAt = dates.value?.rotatedAt;
    if (rotatedAt === undefined || rotatedAt < job.startedAt) {
      const rotated = await rotateInstanceActorKey(env.DB);
      if (rotated.isErr()) {
        return err(rotated.error);
      }
    }
  }
  const due = await runD1(() =>
    queryTyped(env.DB, listAccountsDueKeyRotationSql(job.afterId, job.startedAt, pageSize), IdRow),
  );
  if (due.isErr()) {
    return err(due.error);
  }
  let rotated = 0;
  for (const { id } of due.value) {
    const done = await rotateAccountKey(env, identity, id);
    if (done.isErr() && done.error.kind === "RepositoryError") {
      return err(done.error);
    }
    if (done.isOk()) {
      rotated += 1;
    }
  }
  const last = due.value.at(-1)?.id;
  const total = job.rotated + rotated;
  if (due.value.length < pageSize || last === undefined) {
    console.log(
      JSON.stringify({ kind: "ActorKeysRotationDone", startedAt: job.startedAt, rotated: total }),
    );
    return ok({ rotated, next: undefined });
  }
  return ok({ rotated, next: { ...job, afterId: last, rotated: total } });
};
