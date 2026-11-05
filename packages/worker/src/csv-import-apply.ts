import {
  type ImportRowValue,
  type InstanceIdentity,
  type LocalAccount,
  type OutboxJob,
  type RowOutcomeValue,
  Hostname,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import {
  type AccountRef,
  parseAccountHandle,
  remoteRef,
  resolveAccountHandle,
} from "./account-ref";
import { findAccountById } from "./account-store";
import { blockAccountTarget, unblockAccountTarget } from "./account-block";
import { muteAccount, unmuteAccount } from "./block-mute-store";
import { type Entry, listEntriesPage } from "./csv-entries-store";
import { listMemberKey } from "./csv-import-file";
import {
  finishCsvImport,
  findCsvImportOwner,
  listPendingRows,
  listTitlesInFile,
  type NamingRow,
  recordRowOutcome,
  rowsNaming,
} from "./csv-import-store";
import type { RepositoryError } from "./d1";
import { blockAccountDomain } from "./account-domain-block";
import { unblockDomain } from "./domain-block-store";
import { followAccountRef } from "./follow-ref";
import { type JobPage, measureJobPage } from "./metrics";
import { unfollowAccount } from "./follow-store";
import {
  addListMembers,
  createList,
  findUnfollowedMember,
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
 * Seconds before the next job of an import runs. An import has one job in
 * flight, so this spaces its pages: at most `IMPORT_PAGE_SIZE /
 * IMPORT_PAGE_DELAY_SECONDS` rows a second for one import. It is not a
 * server-wide limit: the queue consumer takes up to `maxBatchSize` (10)
 * messages per invocation and runs them one after the other, so imports of
 * different accounts add up, to at most 10 jobs (100 rows, each maybe a
 * WebFinger lookup and an actor fetch) in one invocation's subrequest budget.
 */
export const IMPORT_PAGE_DELAY_SECONDS = 2;

type Applied = Exclude<RowOutcomeValue, { kind: "Pending" }>;

/**
 * What applying a row came to: the outcome, and the account the row resolved
 * to (its actor URI; for a list row, title and actor URI, see
 * `listMemberKey`) when one did, whatever the outcome.
 */
export type Attempt = Readonly<{ outcome: Applied; resolved: string | undefined }>;

const unresolved = (outcome: Applied): Attempt => ({ outcome, resolved: undefined });

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
  resolvedAs: (ref: AccountRef) => string = (ref) => ref.actorUri,
): Promise<Result<Attempt, RepositoryError>> => {
  const ref = await resolveHandle(env, identity, handle);
  if (ref.isErr()) {
    return err(ref.error);
  }
  const resolved = ref.value;
  if (!resolved) {
    return ok(unresolved(failed("UnknownAccount")));
  }
  return (await use(resolved)).map((outcome) => ({ outcome, resolved: resolvedAs(resolved) }));
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
): Promise<Result<Attempt, RepositoryError>> => {
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
        const blocked = await blockAccountTarget(env, identity, account, {
          accountId: ref.kind === "LocalAccount" ? ref.account.id : null,
          actorUri: ref.actorUri,
        });
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
      const domain = Hostname.fromInput(row.domain);
      if (domain === undefined || domain === identity.domain.toLowerCase()) {
        return ok(unresolved(failed("Refused")));
      }
      const blocked = await blockAccountDomain(env, identity, account, domain);
      return blocked.map(() => unresolved(applied));
    }
    case "Lists":
      return withAccount(
        env,
        identity,
        row.handle,
        async (ref) => {
          if (isSelf(account, ref)) {
            return ok(failed("Refused"));
          }
          const member = memberOf(ref);
          const unfollowed = await findUnfollowedMember(env.DB, account.id, [member]);
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
        },
        (ref) => listMemberKey(row.listTitle, ref.actorUri),
      );
    case "Bookmarks": {
      const status = await findStatusById(env.DB, row.statusId);
      if (status.isErr()) {
        return err(status.error);
      }
      if (!status.value || !(await canViewStatus(env.DB, status.value, account.id))) {
        return ok(unresolved(failed("Unsupported")));
      }
      const bookmarked = await bookmarkStatus(env.DB, account.id, {
        kind: "LocalStatus",
        statusId: status.value.id,
      });
      return bookmarked.map(() => unresolved(applied));
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
    case "Blocks":
      return unblockAccountTarget(env, identity, account, {
        accountId: entry.target.kind === "LocalAccount" ? entry.target.accountId : null,
        actorUri: entry.target.actorUri,
      });
    case "Mutes": {
      const removed = await unmuteAccount(env.DB, account.id, entry.target.actorUri);
      return removed.map(() => undefined);
    }
    case "DomainBlocks": {
      const removed = await unblockDomain(env.DB, account.id, Hostname.ofAuthority(entry.domain));
      return removed.map(() => undefined);
    }
    case "Lists":
      return removeListMembers(env.DB, entry.listId, [entry.member]);
    case "Bookmarks":
      return (
        await unbookmarkStatus(env.DB, account.id, {
          kind: "LocalStatus",
          statusId: entry.statusId,
        })
      ).map(() => undefined);
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

/**
 * Whether the file names `entry`: a row resolved to the same account, or a
 * row that resolved to none has the same handle text. The handle text of a
 * resolved row says nothing: its domain can differ from the actor's host.
 */
const isNamed = (rows: ReadonlyArray<NamingRow>, entry: Entry): boolean =>
  rows.some((row) =>
    row.resolved === null ? row.key === entry.key : row.resolved === entry.resolved,
  );

type ProcessJob = Extract<OutboxJob, { kind: "ProcessCsvImport" }>;

/**
 * Run one page of an import: apply up to {@link IMPORT_PAGE_SIZE} pending rows
 * and queue the next page; after the last row, an overwrite goes on to remove
 * the entries the file does not name ({@link PRUNE_PAGE_SIZE} per job), and
 * the import is then finished. A page redone applies only rows still pending,
 * and applying a row twice changes nothing.
 */
export const processCsvImportJob = (env: Env, job: ProcessJob): Promise<"ok" | "retry"> =>
  measureJobPage(env, job.kind, () => runCsvImportPage(env, job));

/** Where a pass stands for metrics: `size` is the rows applied or entries checked. */
const pass = (
  step: "Rows" | "Prune",
  size: number,
  outcome: "ok" | "retry",
  chained = false,
): JobPage => ({ outcome, size, chained: chained && outcome === "ok", step });

const runCsvImportPage = async (env: Env, job: ProcessJob): Promise<JobPage> => {
  const identity = parseInstanceIdentity(env);
  const owner = await findCsvImportOwner(env.DB, job.importId);
  const stepName = job.step.kind;
  if (identity.isErr() || owner.isErr()) {
    return pass(stepName, 0, "retry");
  }
  if (!owner.value) {
    return pass(stepName, 0, "ok");
  }
  const { accountId, type, mode } = owner.value;
  const account = await findAccountById(env.DB, accountId);
  if (account.isErr()) {
    return pass(stepName, 0, "retry");
  }
  if (!account.value) {
    return pass(stepName, 0, "ok");
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
      return pass("Rows", 0, "retry");
    }
    const rows = pending.value.length;
    for (const { position, row } of pending.value) {
      const attempt = await applyImportRow(env, identity.value, user, row);
      if (attempt.isErr()) {
        return pass("Rows", rows, "retry");
      }
      const recorded = await recordRowOutcome(
        env.DB,
        job.importId,
        position,
        attempt.value.outcome,
        attempt.value.resolved,
      );
      if (recorded.isErr()) {
        return pass("Rows", rows, "retry");
      }
    }
    const last = pending.value.at(-1);
    if (last !== undefined && rows >= IMPORT_PAGE_SIZE) {
      const queued = await enqueue(env, {
        ...job,
        step: { kind: "Rows", afterPosition: last.position },
      });
      return pass("Rows", rows, queued ? "ok" : "retry", true);
    }
    if (mode.kind === "Overwrite") {
      const queued = await enqueue(env, { ...job, step: { kind: "Prune", afterCursor: "" } });
      return pass("Rows", rows, queued ? "ok" : "retry", true);
    }
    const finished = await finishCsvImport(env.DB, job.importId);
    return pass("Rows", rows, finished.isOk() ? "ok" : "retry");
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
    ? await rowsNaming(env.DB, job.importId, page.value.entries)
    : undefined;
  const titles = type.kind === "Lists" ? await listTitlesInFile(env.DB, job.importId) : undefined;
  if (page.isErr() || named === undefined || named.isErr() || titles?.isErr()) {
    return pass("Prune", 0, "retry");
  }
  const entries = page.value.entries.length;
  for (const entry of page.value.entries) {
    const keep =
      isNamed(named.value, entry) ||
      (entry.kind === "Lists" && titles?.isOk() && !titles.value.has(entry.title));
    if (!keep && (await removeEntry(env, identity.value, user, entry)).isErr()) {
      return pass("Prune", entries, "retry");
    }
  }
  if (page.value.next !== undefined) {
    const queued = await enqueue(env, {
      ...job,
      step: { kind: "Prune", afterCursor: page.value.next },
    });
    return pass("Prune", entries, queued ? "ok" : "retry", true);
  }
  const finished = await finishCsvImport(env.DB, job.importId);
  return pass("Prune", entries, finished.isOk() ? "ok" : "retry");
};
