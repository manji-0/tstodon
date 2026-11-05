import { err, ok, type Result } from "neverthrow";
import { type AccountRef, refAcct } from "./account-ref";
import type { InstanceIdentity } from "@tstodon/domain";
import { blockAccountTarget } from "./account-block";
import { findAccountById } from "./account-store";
import { findActiveMute, findBlock, muteAccount } from "./block-mute-store";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { findFollowKind } from "./follow-store";
import { listBlockers, listMuters, listNoters } from "./move-carry-store";
import { findOutboundFollow } from "./outbound-follow-store";
import { findAccountNoteText, setAccountNote } from "./relationship-store";

/** Mastodon's `AccountNote::COMMENT_SIZE_LIMIT`. */
export const NOTE_SIZE_LIMIT = 2000;

/** The id a local account has in `blocks`, `mutes` and `account_notes` rows; remote targets have none. */
const targetAccountId = (to: AccountRef): string | null =>
  to.kind === "LocalAccount" ? to.account.id : null;

/** Which page of accounts to carry over: those after `afterId` in account id order, at most `pageSize`. */
export type CarryPage = Readonly<{ afterId: string; pageSize: number }>;

/** Whether `accountId` follows `to` (an accepted follow), as Mastodon's `following?`. */
const follows = async (
  env: Env,
  accountId: string,
  to: AccountRef,
): Promise<Result<boolean, RepositoryError>> => {
  if (to.kind === "LocalAccount") {
    return (await findFollowKind(env.DB, accountId, to.account.id)).map(
      (kind) => kind === "Accepted",
    );
  }
  return (await findOutboundFollow(env.DB, accountId, to.actorUri)).map(
    (follow) => follow?.state.kind === "Accepted",
  );
};

/** The texts Mastodon puts in front of what it carries over (`move_handler` in its `en.yml`). */
const carriedText = (kind: "notes" | "blocks" | "mutes", from: AccountRef): string => {
  const acct = refAcct(from);
  switch (kind) {
    case "notes":
      return `This user moved from ${acct}, here were your previous notes about them:`;
    case "blocks":
      return `This user moved from ${acct}, which you had blocked.`;
    case "mutes":
      return `This user moved from ${acct}, which you had muted.`;
  }
};

/**
 * Leave `accountId` a note on `to` saying where the block or mute came from,
 * unless they already have a note on it (Mastodon's `add_account_note_if_needed!`).
 */
const addNoteIfNeeded = async (
  env: Env,
  accountId: string,
  from: AccountRef,
  to: AccountRef,
  kind: "blocks" | "mutes",
): Promise<Result<void, RepositoryError>> => {
  const existing = await findAccountNoteText(env.DB, accountId, to.actorUri);
  if (existing.isErr() || existing.value !== undefined) {
    return existing.isErr() ? err(existing.error) : ok(undefined);
  }
  return setAccountNote(
    env.DB,
    accountId,
    { accountId: targetAccountId(to), actorUri: to.actorUri, id: to.actorUri },
    carriedText(kind, from),
  );
};

/**
 * Copy one page of the notes written about `from` to `to`, as Mastodon's
 * `copy_account_notes!`: the note leads with where the account moved from; a
 * note the author already has on `to` keeps its text after the copied one.
 * A copy that would pass {@link NOTE_SIZE_LIMIT} leaves the note on `to` as it
 * is, or, for an author with none, is saved without the lead. Redoing a page
 * adds nothing: a note that already leads with the text is left alone.
 * Resolves to the cursor of the next page, or `undefined` after the last.
 */
export const moveNotePage = async (
  env: Env,
  from: AccountRef,
  to: AccountRef,
  page: CarryPage,
): Promise<Result<string | undefined, RepositoryError>> => {
  const notes = await listNoters(env.DB, from.actorUri, page.afterId, page.pageSize);
  if (notes.isErr()) {
    return err(notes.error);
  }
  const lead = carriedText("notes", from);
  for (const note of notes.value.rows) {
    const existing = await findAccountNoteText(env.DB, note.accountId, to.actorUri);
    if (existing.isErr()) {
      return err(existing.error);
    }
    if (existing.value?.startsWith(lead)) {
      continue;
    }
    const merged =
      existing.value === undefined
        ? [lead, note.note].join("\n")
        : [lead, note.note, "\n", existing.value].join("\n");
    const text =
      merged.length <= NOTE_SIZE_LIMIT
        ? merged
        : existing.value === undefined && note.note.length <= NOTE_SIZE_LIMIT
          ? note.note
          : undefined;
    if (text === undefined) {
      continue;
    }
    const saved = await setAccountNote(
      env.DB,
      note.accountId,
      { accountId: targetAccountId(to), actorUri: to.actorUri, id: to.actorUri },
      text,
    );
    if (saved.isErr()) {
      return err(saved.error);
    }
  }
  return ok(notes.value.next);
};

/**
 * Block `to` for one page of the local accounts that blocked `from`, as
 * Mastodon's `carry_blocks_over!`: not for an account that already blocks or
 * follows `to`. The block of `from` stays. A new block leaves a note on `to`
 * saying where it came from, if the account has none.
 */
export const moveBlockPage = async (
  env: Env,
  identity: InstanceIdentity,
  from: AccountRef,
  to: AccountRef,
  page: CarryPage,
): Promise<Result<string | undefined, RepositoryError>> => {
  const blockers = await listBlockers(env.DB, from.actorUri, page.afterId, page.pageSize);
  if (blockers.isErr()) {
    return err(blockers.error);
  }
  for (const { accountId } of blockers.value.rows) {
    if (to.kind === "LocalAccount" && to.account.id === accountId) {
      continue;
    }
    const [blocking, following] = await Promise.all([
      findBlock(env.DB, accountId, to.actorUri),
      follows(env, accountId, to),
    ]);
    if (blocking.isErr()) {
      return err(blocking.error);
    }
    if (following.isErr()) {
      return err(following.error);
    }
    if (blocking.value || following.value) {
      continue;
    }
    const blocker = await findAccountById(env.DB, accountId);
    if (blocker.isErr()) {
      return err(blocker.error);
    }
    if (!blocker.value) {
      continue;
    }
    const blocked = await blockAccountTarget(env, identity, blocker.value, {
      accountId: targetAccountId(to),
      actorUri: to.actorUri,
    });
    if (blocked.isErr()) {
      return err(blocked.error);
    }
    const noted = await addNoteIfNeeded(env, accountId, from, to, "blocks");
    if (noted.isErr()) {
      return err(noted.error);
    }
  }
  return ok(blockers.value.next);
};

/**
 * Mute `to` for one page of the local accounts that muted `from`, as
 * Mastodon's `carry_mutes_over!`: with the same choice about notifications,
 * for good, not for an account that already mutes or follows `to`, and not
 * for a mute that has run out. A new mute leaves a note like a new block.
 */
export const moveMutePage = async (
  env: Env,
  from: AccountRef,
  to: AccountRef,
  page: CarryPage,
): Promise<Result<string | undefined, RepositoryError>> => {
  const muters = await listMuters(env.DB, from.actorUri, page.afterId, page.pageSize);
  if (muters.isErr()) {
    return err(muters.error);
  }
  const now = nowIso();
  for (const muter of muters.value.rows) {
    if (muter.expiresAt !== null && muter.expiresAt <= now) {
      continue;
    }
    if (to.kind === "LocalAccount" && to.account.id === muter.accountId) {
      continue;
    }
    const [muting, following] = await Promise.all([
      findActiveMute(env.DB, muter.accountId, to.actorUri),
      follows(env, muter.accountId, to),
    ]);
    if (muting.isErr()) {
      return err(muting.error);
    }
    if (following.isErr()) {
      return err(following.error);
    }
    if (muting.value !== undefined || following.value) {
      continue;
    }
    const muted = await muteAccount(env.DB, muter.accountId, targetAccountId(to), to.actorUri, {
      notifications: muter.notifications,
      expiresAt: null,
    });
    if (muted.isErr()) {
      return err(muted.error);
    }
    const noted = await addNoteIfNeeded(env, muter.accountId, from, to, "mutes");
    if (noted.isErr()) {
      return err(noted.error);
    }
  }
  return ok(muters.value.next);
};
