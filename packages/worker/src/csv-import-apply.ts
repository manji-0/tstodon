import {
  type ImportRowValue,
  type InstanceIdentity,
  type LocalAccount,
  type OutboxJob,
  type RowOutcomeValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import {
  type AccountRef,
  parseAccountHandle,
  remoteRef,
  resolveAccountHandle,
} from "./account-ref";
import { findAccountById } from "./account-store";
import { blockAccount, muteAccount, unblockAccount, unmuteAccount } from "./block-mute-store";
import { type Entry, listEntriesPage } from "./csv-entries-store";
import {
  finishCsvImport,
  findCsvImportOwner,
  keysInFile,
  listPendingRows,
  listTitlesInFile,
  recordRowOutcome,
} from "./csv-import-store";
import type { RepositoryError } from "./d1";
import { blockDomain, normalizeDomain, unblockDomain } from "./domain-block-store";
import { followAccountRef } from "./follow-ref";
import { unfollowAccount } from "./follow-store";
import {
  addListMembers,
  createList,
  findUnfollowedRemoteMember,
  type ListMember,
  listListsForAccount,
  removeListMembers,
} from "./list-store";
import { unfollowRemoteActor } from "./outbound-follow";
import { findRemoteActorByHandle, findRemoteActorByUri } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import { bookmarkStatus, unbookmarkStatus } from "./status-interaction-store";
import { findStatusById } from "./status-store";
import { canViewStatus } from "./visibility-guard";

/**
 * Rows applied per queue job. A row can cost a WebFinger lookup and an actor
 * fetch, so a job stays well under a Worker invocation's subrequest budget.
 */
export const IMPORT_PAGE_SIZE = 10;

/** Existing entries compared with the file per job in an overwrite. */
export const PRUNE_PAGE_SIZE = 50;

/**
 * Seconds before the next job of an import runs. With one import running per
 * account, and the queue consumer running one job at a time, this holds the
 * rate of remote lookups to at most `IMPORT_PAGE_SIZE / IMPORT_PAGE_DELAY_SECONDS`
 * a second for the whole server.
 */
export const IMPORT_PAGE_DELAY_SECONDS = 2;

type Applied = Exclude<RowOutcomeValue, { kind: "Pending" }>;

const applied: Applied = { kind: "Applied" };
const failed = (kind: "UnknownAccount" | "Refused" | "NotFollowed" | "Unsupported"): Applied => ({
  kind: "Failed",
  failure: { kind },
});

/**
 * The account a handle names. A remote account already cached is used as it is,
 * so a file of accounts the server knows costs no lookups; any other is
 * resolved by WebFinger within the federation limits (see `resolveAccountHandle`).
 * `undefined` when no account answers.
 */
const resolveHandle = async (
  env: Env,
  identity: InstanceIdentity,
  handle: string,
): Promise<Result<AccountRef | undefined, RepositoryError>> => {
  const parsed = parseAccountHandle(handle);
  if (parsed?.domain !== undefined && parsed.domain !== identity.domain) {
    const cached = await findRemoteActorByHandle(env.DB, parsed.username, parsed.domain);
    if (cached.isErr()) {
      return err(cached.error);
    }
    if (cached.value) {
      return ok(remoteRef(cached.value));
    }
  }
  const resolved = await resolveAccountHandle(env, identity, handle);
  if (resolved.isOk()) {
    return ok(resolved.value);
  }
  return resolved.error.kind === "RepositoryError" ? err(resolved.error) : ok(undefined);
};

const memberOf = (ref: AccountRef): ListMember =>
  ref.kind === "LocalAccount"
    ? { kind: "LocalAccount", accountId: ref.account.id }
    : { kind: "RemoteActor", actorUri: ref.actorUri };

/** Block, mute, or follow a resolved account, as the API does; the account itself is refused. */
const withAccount = async (
  env: Env,
  identity: InstanceIdentity,
  handle: string,
  use: (ref: AccountRef) => Promise<Result<Applied, RepositoryError>>,
): Promise<Result<Applied, RepositoryError>> => {
  const ref = await resolveHandle(env, identity, handle);
  if (ref.isErr()) {
    return err(ref.error);
  }
  return ref.value ? use(ref.value) : ok(failed("UnknownAccount"));
};

const isSelf = (account: LocalAccount, ref: AccountRef): boolean =>
  ref.kind === "LocalAccount" && ref.account.id === account.id;

const listFor = async (
  db: D1Database,
  accountId: string,
  title: string,
): Promise<Result<string, RepositoryError>> => {
  const lists = await listListsForAccount(db, accountId);
  if (lists.isErr()) {
    return err(lists.error);
  }
  const existing = lists.value.find((list) => list.title === title);
  if (existing) {
    return ok(existing.id);
  }
  const created = await createList(db, accountId, { title });
  return created.isErr() ? err(created.error) : ok(created.value.id);
};

/**
 * Apply one row for `account` with the functions the API uses (follow,
 * block, mute, domain block, list members, bookmark), so the rules are theirs.
 * A row that is refused or names nothing is a `Failed` outcome; only a
 * storage error is an `Err`, and the job retries it.
 */
export const applyImportRow = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  row: ImportRowValue,
): Promise<Result<Applied, RepositoryError>> => {
  switch (row.kind) {
    case "Following":
      return withAccount(env, identity, row.handle, async (ref) => {
        const followed = await followAccountRef(
          env,
          identity,
          account,
          ref,
          { reblogs: row.reblogs, notify: row.notify, languages: row.languages },
          { kind: "UpdateOptions" },
        );
        return followed.map((done) => (done ? applied : failed("Refused")));
      });
    case "Blocks":
      return withAccount(env, identity, row.handle, async (ref) => {
        if (isSelf(account, ref)) {
          return ok(failed("Refused"));
        }
        const blocked = await blockAccount(
          env.DB,
          account.id,
          ref.kind === "LocalAccount" ? ref.account.id : null,
          ref.actorUri,
        );
        return blocked.map(() => applied);
      });
    case "Mutes":
      return withAccount(env, identity, row.handle, async (ref) => {
        if (isSelf(account, ref)) {
          return ok(failed("Refused"));
        }
        const muted = await muteAccount(
          env.DB,
          account.id,
          ref.kind === "LocalAccount" ? ref.account.id : null,
          ref.actorUri,
          { notifications: row.hideNotifications, expiresAt: null },
        );
        return muted.map(() => applied);
      });
    case "DomainBlocks": {
      const domain = normalizeDomain(row.domain);
      if (domain === identity.domain.toLowerCase()) {
        return ok(failed("Refused"));
      }
      const blocked = await blockDomain(env.DB, account.id, domain);
      return blocked.map(() => applied);
    }
    case "Lists":
      return withAccount(env, identity, row.handle, async (ref) => {
        if (isSelf(account, ref)) {
          return ok(failed("Refused"));
        }
        const member = memberOf(ref);
        const unfollowed = await findUnfollowedRemoteMember(env.DB, account.id, [member]);
        if (unfollowed.isErr()) {
          return err(unfollowed.error);
        }
        if (unfollowed.value) {
          return ok(failed("NotFollowed"));
        }
        const listId = await listFor(env.DB, account.id, row.listTitle);
        if (listId.isErr()) {
          return err(listId.error);
        }
        const added = await addListMembers(env.DB, listId.value, [member]);
        return added.map(() => applied);
      });
    case "Bookmarks": {
      const status = await findStatusById(env.DB, row.statusId);
      if (status.isErr()) {
        return err(status.error);
      }
      if (!status.value || !(await canViewStatus(env.DB, status.value, account.id))) {
        return ok(failed("Unsupported"));
      }
      const bookmarked = await bookmarkStatus(env.DB, account.id, row.statusId);
      return bookmarked.map(() => applied);
    }
  }
};

/** Remove one existing entry, as the API's unfollow, unblock, unmute, and so on do. */
const removeEntry = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  entry: Entry,
): Promise<Result<void, RepositoryError>> => {
  switch (entry.kind) {
    case "Following": {
      if (entry.target.kind === "LocalAccount") {
        return unfollowAccount(env.DB, account.id, entry.target.accountId);
      }
      const actor = await findRemoteActorByUri(env.DB, entry.target.actorUri);
      if (actor.isErr()) {
        return err(actor.error);
      }
      return actor.value ? unfollowRemoteActor(env, identity, account, actor.value) : ok(undefined);
    }
    case "Blocks": {
      const removed = await unblockAccount(env.DB, account.id, entry.target.actorUri);
      return removed.map(() => undefined);
    }
    case "Mutes": {
      const removed = await unmuteAccount(env.DB, account.id, entry.target.actorUri);
      return removed.map(() => undefined);
    }
    case "DomainBlocks": {
      const removed = await unblockDomain(env.DB, account.id, entry.domain);
      return removed.map(() => undefined);
    }
    case "Lists":
      return removeListMembers(env.DB, entry.listId, [entry.member]);
    case "Bookmarks":
      return unbookmarkStatus(env.DB, account.id, entry.statusId);
  }
};

const enqueue = async (env: Env, job: OutboxJob): Promise<boolean> => {
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job, { delaySeconds: IMPORT_PAGE_DELAY_SECONDS });
    return true;
  } catch {
    console.error(
      JSON.stringify({
        kind: "CsvImportNotQueued",
        importId: "importId" in job ? job.importId : "",
      }),
    );
    return false;
  }
};

/** Queue the first job of an import. `false` when the queue refused it. */
export const startCsvImport = (env: Env, importId: string): Promise<boolean> =>
  enqueue(env, {
    kind: "ProcessCsvImport",
    importId,
    step: { kind: "Rows", afterPosition: 0 },
  });

type ProcessJob = Extract<OutboxJob, { kind: "ProcessCsvImport" }>;

/**
 * Run one page of an import: apply up to {@link IMPORT_PAGE_SIZE} pending rows
 * and queue the next page; after the last row, an overwrite goes on to remove
 * the entries the file does not name ({@link PRUNE_PAGE_SIZE} per job), and
 * the import is then finished. A page redone applies only rows still pending,
 * and applying a row twice changes nothing.
 */
export const processCsvImportJob = async (env: Env, job: ProcessJob): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  const owner = await findCsvImportOwner(env.DB, job.importId);
  if (identity.isErr() || owner.isErr()) {
    return "retry";
  }
  if (!owner.value) {
    return "ok";
  }
  const { accountId, type, mode } = owner.value;
  const account = await findAccountById(env.DB, accountId);
  if (account.isErr()) {
    return "retry";
  }
  if (!account.value) {
    return "ok";
  }
  const user = account.value;

  if (job.step.kind === "Rows") {
    const pending = await listPendingRows(
      env.DB,
      job.importId,
      job.step.afterPosition,
      IMPORT_PAGE_SIZE,
    );
    if (pending.isErr()) {
      return "retry";
    }
    for (const { position, row } of pending.value) {
      const outcome = await applyImportRow(env, identity.value, user, row);
      if (outcome.isErr()) {
        return "retry";
      }
      const recorded = await recordRowOutcome(env.DB, job.importId, position, outcome.value);
      if (recorded.isErr()) {
        return "retry";
      }
    }
    const last = pending.value.at(-1);
    if (last !== undefined && pending.value.length >= IMPORT_PAGE_SIZE) {
      return (await enqueue(env, { ...job, step: { kind: "Rows", afterPosition: last.position } }))
        ? "ok"
        : "retry";
    }
    if (mode.kind === "Overwrite") {
      return (await enqueue(env, { ...job, step: { kind: "Prune", afterCursor: "" } }))
        ? "ok"
        : "retry";
    }
    return (await finishCsvImport(env.DB, job.importId)).isOk() ? "ok" : "retry";
  }

  const page = await listEntriesPage(
    env.DB,
    identity.value,
    accountId,
    type,
    job.step.afterCursor,
    PRUNE_PAGE_SIZE,
  );
  const named = page.isOk()
    ? await keysInFile(
        env.DB,
        job.importId,
        page.value.entries.map((entry) => entry.key),
      )
    : undefined;
  const titles = type.kind === "Lists" ? await listTitlesInFile(env.DB, job.importId) : undefined;
  if (page.isErr() || named === undefined || named.isErr() || titles?.isErr()) {
    return "retry";
  }
  for (const entry of page.value.entries) {
    const keep =
      named.value.has(entry.key) ||
      (entry.kind === "Lists" && titles?.isOk() && !titles.value.has(entry.title));
    if (!keep && (await removeEntry(env, identity.value, user, entry)).isErr()) {
      return "retry";
    }
  }
  if (page.value.next !== undefined) {
    return (await enqueue(env, { ...job, step: { kind: "Prune", afterCursor: page.value.next } }))
      ? "ok"
      : "retry";
  }
  return (await finishCsvImport(env.DB, job.importId)).isOk() ? "ok" : "retry";
};
