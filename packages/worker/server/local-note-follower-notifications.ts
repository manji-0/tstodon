import {
  type LocalNote,
  type NotifiedNote,
  NoteThread,
  type OutboxJob,
  StatusNotificationAudience,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { notifyingFollowersAmong, notifyingFollowersPage } from "./follow-store";
import { listStatusMentions } from "./mention-store";
import { measureJobPage } from "./metrics";
import { notifyAccountOnce } from "./notify";
import type { NotifyingFollowerPage } from "./outbound-follow-store";
import { queueOutboxJobs } from "./queue-jobs";
import { NOTIFYING_FOLLOWER_PAGE_SIZE } from "./remote-status-persist";
import { findStatusById, listStatusReplyLinks } from "./status-store";

type FollowersJob = Extract<OutboxJob, { kind: "NotifyLocalNoteFollowers" }>;

const NO_FOLLOWERS: NotifyingFollowerPage = { followers: [], next: undefined };

/**
 * The notifying followers the note can reach on the page after the follow
 * `afterFollowId` (empty for the first). A reply to someone else reaches
 * none, so no follower is read; a direct note reaches only the accounts it
 * names (`deliver_to_mentioned_followers!`), read in one page, so the
 * author's other followers are not paged through.
 */
const reachableFollowers = (
  db: D1Database,
  note: Pick<LocalNote, "id" | "accountId">,
  audience: NotifiedNote,
  afterFollowId: string,
): Promise<Result<NotifyingFollowerPage, RepositoryError>> => {
  if (audience.thread.kind === "ReplyToOther") {
    return Promise.resolve(ok(NO_FOLLOWERS));
  }
  switch (audience.visibility.kind) {
    case "Limited":
    case "Direct":
      return notifyingFollowersAmong(db, note.accountId, note.id, [...audience.addressed]).then(
        (found) => found.map((followers) => ({ followers, next: undefined })),
      );
    case "Public":
    case "Unlisted":
    case "FollowersOnly":
      return notifyingFollowersPage(
        db,
        note.accountId,
        note.id,
        afterFollowId,
        NOTIFYING_FOLLOWER_PAGE_SIZE,
      );
  }
};

/**
 * Read a page of the followers the note can reach ({@link reachableFollowers}),
 * and queue a `Follower` job for each one it reaches
 * ({@link StatusNotificationAudience}) and the next page when this one is
 * full. Each follower is on one page only, as pages follow follow ids.
 * Resolves to how many followers the page read, and whether a next page
 * was queued.
 */
const queueFollowerPage = async (
  env: Env,
  note: Pick<LocalNote, "id" | "accountId">,
  audience: NotifiedNote,
  afterFollowId: string,
): Promise<Result<Readonly<{ read: number; chained: boolean }>, RepositoryError>> => {
  const page = await reachableFollowers(env.DB, note, audience, afterFollowId);
  if (page.isErr()) {
    return err(page.error);
  }
  const { followers, next } = page.value;
  const jobs: FollowersJob[] = [
    ...StatusNotificationAudience.recipients(audience, followers).map(
      (accountId): FollowersJob => ({
        kind: "NotifyLocalNoteFollowers",
        statusId: note.id,
        step: { kind: "Follower", accountId },
      }),
    ),
    ...(next === undefined
      ? []
      : [
          {
            kind: "NotifyLocalNoteFollowers",
            statusId: note.id,
            step: { kind: "Page", afterFollowId: next },
          } satisfies FollowersJob,
        ]),
  ];
  const queued = await queueOutboxJobs(env, jobs);
  return queued.map(() => ({ read: followers.length, chained: next !== undefined }));
};

/**
 * Send a new local note's `status` notification to its author's notifying
 * followers, as Mastodon's `FanOutOnWriteService#deliver_to_all_followers!`
 * does from workers: the publish reads the first page and queues a job for
 * each follower and the next page, so what it costs stays flat with the
 * number of followers. Each job notifies once (`notifyAccountOnce`), so a
 * retried page or a redelivered job notifies nobody twice.
 */
export const notifyLocalNoteFollowers = async (
  env: Env,
  note: LocalNote,
  audience: NotifiedNote,
): Promise<Result<void, RepositoryError>> =>
  (await queueFollowerPage(env, note, audience, "")).map(() => undefined);

/**
 * Who a stored local note's `status` notification reaches besides its
 * follows, read back as the publish decided it: its visibility, language,
 * the accounts it mentions, and whom it answers.
 */
const storedAudience = async (
  db: D1Database,
  note: LocalNote,
): Promise<Result<NotifiedNote, RepositoryError>> => {
  const [mentions, links] = await Promise.all([
    listStatusMentions(db, [note.id]),
    listStatusReplyLinks(db, [note.id]),
  ]);
  if (mentions.isErr()) {
    return err(mentions.error);
  }
  if (links.isErr()) {
    return err(links.error);
  }
  return ok({
    visibility: note.visibility,
    thread: NoteThread.of(links.value.get(note.id)?.link ?? { kind: "NotReply" }, {
      kind: "LocalAccount",
      accountId: note.accountId,
    }),
    language: note.language,
    addressed: new Set(mentions.value.get(note.id)?.accountIds ?? []),
  });
};

/**
 * `NotifyLocalNoteFollowers`: a page of the author's notifying followers, or
 * one follower's `status` notification. A note that is gone notifies nobody.
 */
export const processNotifyLocalNoteFollowersJob = async (
  env: Env,
  job: FollowersJob,
): Promise<"ok" | "retry"> => {
  const { step } = job;
  if (step.kind === "Page") {
    return measureJobPage(env, job.kind, async () => {
      const retry = { outcome: "retry", size: -1, chained: false } as const;
      const found = await findStatusById(env.DB, job.statusId);
      if (found.isErr()) {
        return retry;
      }
      const note = found.value;
      if (note?.kind !== "LocalNote") {
        return { outcome: "ok", size: 0, chained: false };
      }
      const audience = await storedAudience(env.DB, note);
      if (audience.isErr()) {
        return retry;
      }
      const page = await queueFollowerPage(env, note, audience.value, step.afterFollowId);
      return page.isOk()
        ? { outcome: "ok", size: page.value.read, chained: page.value.chained }
        : retry;
    });
  }
  const found = await findStatusById(env.DB, job.statusId);
  if (found.isErr()) {
    return "retry";
  }
  if (found.value?.kind !== "LocalNote") {
    return "ok";
  }
  const sent = await notifyAccountOnce(env, {
    accountId: step.accountId,
    fromAccountId: found.value.accountId,
    kind: "status",
    statusId: job.statusId,
  });
  return sent.isOk() ? "ok" : "retry";
};
