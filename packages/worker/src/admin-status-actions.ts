import type { InstanceIdentity } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountById } from "./account-store";
import { nowIso } from "./clock";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { enqueueHomeFanOut } from "./home-fan-out";
import { htmlToText } from "./html";
import { type IdCursor, idCursorFragment } from "./id-cursor";
import { deleteLocalStatus } from "./local-status-delete";
import { announceNoteUpdate } from "./local-status-update";
import { enqueuePublicFanOut } from "./public-fan-out";
import { removeRemoteStatus } from "./remote-status-delete";
import { setRemoteStatusSensitive } from "./remote-status-store";
import type { ReportParty } from "./report-store";
import { findStatusById, setNoteSensitive } from "./status-store";

/**
 * Per-post moderation, as Mastodon's `/admin/accounts/:id/statuses` offers it:
 * look at an account's posts and mark them sensitive or delete them. The
 * admin REST API has no counterpart, so the admin web pages are its only caller.
 */

/** One post of the account, as the moderation page lists it. */
export type AdminStatusEntry = Readonly<{
  id: string;
  /** The post's plain text. */
  text: string;
  spoilerText: string;
  visibility: string;
  sensitive: boolean;
  createdAt: string;
}>;

const LocalEntryRowSchema = z.object({
  id: z.string(),
  content_text: z.string(),
  spoiler_text: z.string(),
  visibility: z.string(),
  sensitive: z.number(),
  created_at: z.string(),
});

const RemoteEntryRowSchema = z.object({
  id: z.string(),
  content_html: z.string(),
  spoiler_text: z.string(),
  visibility: z.string(),
  sensitive: z.number(),
  published_at: z.string(),
});

/** The owner's own posts, newest first: a local account's notes (not its boosts), or a remote actor's cached notes. */
export const listAdminStatuses = async (
  db: D1Database,
  owner: ReportParty,
  page: Readonly<{ limit: number; cursor?: IdCursor | undefined }>,
): Promise<Result<ReadonlyArray<AdminStatusEntry>, RepositoryError>> =>
  runD1(async () => {
    const { where, order, binds } = idCursorFragment(page.cursor);
    if (owner.kind === "Local") {
      const { results } = await db
        .prepare(
          `SELECT id, COALESCE(content_text, '') AS content_text, COALESCE(spoiler_text, '') AS spoiler_text, visibility, sensitive, created_at
           FROM statuses WHERE account_id = ? AND kind = 'LocalNote' ${where} ${order} LIMIT ?`,
        )
        .bind(owner.accountId, ...binds, page.limit)
        .all();
      return parseRows(LocalEntryRowSchema, results).map((row) => ({
        id: row.id,
        text: row.content_text,
        spoilerText: row.spoiler_text,
        visibility: row.visibility,
        sensitive: row.sensitive !== 0,
        createdAt: row.created_at,
      }));
    }
    const { results } = await db
      .prepare(
        `SELECT id, content_html, spoiler_text, visibility, sensitive, published_at
         FROM remote_statuses WHERE actor_uri = ? ${where} ${order} LIMIT ?`,
      )
      .bind(owner.actorUri, ...binds, page.limit)
      .all();
    return parseRows(RemoteEntryRowSchema, results).map((row) => ({
      id: row.id,
      text: htmlToText(row.content_html),
      spoilerText: row.spoiler_text,
      visibility: row.visibility,
      sensitive: row.sensitive !== 0,
      createdAt: row.published_at,
    }));
  });

/** What a moderator does to selected posts. */
export type StatusModeration = "sensitize" | "unsensitize" | "delete";

const sensitizeLocal = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
  statusId: string,
  sensitive: boolean,
): Promise<Result<boolean, RepositoryError>> => {
  const changed = await setNoteSensitive(env.DB, statusId, accountId, sensitive);
  if (changed.isErr() || !changed.value) {
    return changed;
  }
  const [account, status] = await Promise.all([
    findAccountById(env.DB, accountId),
    findStatusById(env.DB, statusId),
  ]);
  if (account.isOk() && account.value && status.isOk() && status.value?.kind === "LocalNote") {
    const note = status.value;
    // The audience hears of the change like an edit; a direct note only reaches its addressees
    // through the mentions an edit resolves, so it is not federated here.
    const announced = await announceNoteUpdate(
      env,
      identity,
      account.value,
      note,
      nowIso(),
      note.visibility.kind !== "Direct",
    );
    if (announced.isErr()) {
      console.error(JSON.stringify({ kind: "StatusUpdateNotFederated", statusId }));
    }
  }
  return ok(true);
};

const sensitizeRemote = async (
  env: Env,
  actorUri: string,
  statusId: string,
  sensitive: boolean,
): Promise<Result<boolean, RepositoryError>> => {
  const changed = await setRemoteStatusSensitive(env.DB, statusId, actorUri, sensitive);
  if (changed.isErr() || !changed.value) {
    return changed.map((row) => row !== undefined);
  }
  await enqueueHomeFanOut(env, {
    event: "status.update",
    entryId: statusId,
    author: { kind: "RemoteActor", actorUri },
  });
  if (changed.value.public) {
    await enqueuePublicFanOut(env, { event: "status.update", entryId: statusId });
  }
  return ok(true);
};

const deleteLocal = async (
  env: Env,
  identity: InstanceIdentity,
  accountId: string,
  statusId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const [account, status] = await Promise.all([
    findAccountById(env.DB, accountId),
    findStatusById(env.DB, statusId),
  ]);
  if (account.isErr()) {
    return err(account.error);
  }
  if (status.isErr()) {
    return err(status.error);
  }
  if (!account.value || !status.value || status.value.accountId !== accountId) {
    return ok(false);
  }
  return deleteLocalStatus(env, identity, account.value, status.value);
};

/**
 * Apply `action` to the owner's posts among `statusIds`; a post the owner did
 * not write is skipped, so a forged id cannot reach another account's post.
 * Returns how many posts changed.
 */
export const moderateStatuses = async (
  env: Env,
  identity: InstanceIdentity,
  owner: ReportParty,
  statusIds: ReadonlyArray<string>,
  action: StatusModeration,
): Promise<Result<number, RepositoryError>> => {
  let changed = 0;
  for (const statusId of new Set(statusIds)) {
    let done: Result<boolean, RepositoryError>;
    if (owner.kind === "Local") {
      done =
        action === "delete"
          ? await deleteLocal(env, identity, owner.accountId, statusId)
          : await sensitizeLocal(env, identity, owner.accountId, statusId, action === "sensitize");
    } else {
      done =
        action === "delete"
          ? await removeRemoteStatus(env, owner.actorUri, { kind: "Id", id: statusId })
          : await sensitizeRemote(env, owner.actorUri, statusId, action === "sensitize");
    }
    if (done.isErr()) {
      return err(done.error);
    }
    if (done.value) {
      changed += 1;
    }
  }
  return ok(changed);
};
