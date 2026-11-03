import {
  type InstanceIdentity,
  OutboxJob,
  type OutboxJob as OutboxJobValue,
  type StreamEventValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { listHomeFanOutAccounts } from "./generated/prisma/sql";
import { parseInstanceIdentity } from "./runtime-config";
import { publishToAccount } from "./stream-publish";
import { homeTimelineDocuments } from "./timeline-documents";
import { queryTyped } from "./typed-sql";

type FanOutHome = Extract<OutboxJobValue, { kind: "FanOutHome" }>;

/**
 * Followers told per pass. Each one costs a home timeline query for the entry,
 * so a page stays well inside a queue invocation's subrequest budget; a full
 * page queues a `FanOutHome` job for the next.
 */
export const HOME_FAN_OUT_PAGE_SIZE = 20;

/**
 * Queue telling the author's local followers about a home timeline entry, as
 * Mastodon's `FanOutOnWriteService` and `RemoveStatusService` do for the
 * `user` stream. Best effort: the entry is stored either way, and a follower
 * who misses the event still sees the entry on the next home timeline fetch.
 */
export const enqueueHomeFanOut = async (
  env: Env,
  fanOut: Readonly<{
    event: FanOutHome["event"];
    entryId: string;
    author:
      | Readonly<{ kind: "LocalAccount"; accountId: string }>
      | Readonly<{ kind: "RemoteActor"; actorUri: string }>;
  }>,
): Promise<void> => {
  const job = OutboxJob.parse({ kind: "FanOutHome", ...fanOut, afterAccountId: "" });
  if (job.isErr()) {
    return;
  }
  try {
    await env.OUTBOX_PROCESS_QUEUE.send(job.value);
  } catch {
    console.error(JSON.stringify({ kind: "HomeFanOutNotQueued", entryId: fanOut.entryId }));
  }
};

/** The event a follower hears, or nothing when the entry is not on its home timeline. */
const followerEvent = async (
  env: Env,
  identity: InstanceIdentity,
  job: FanOutHome,
  accountId: string,
): Promise<Result<StreamEventValue | undefined, RepositoryError>> => {
  if (job.event === "delete") {
    return ok({ kind: "delete", statusId: job.entryId });
  }
  const documents = await homeTimelineDocuments(env, identity, accountId, 1, {
    onlyId: job.entryId,
  });
  if (documents.isErr()) {
    return err(documents.error);
  }
  const [document] = documents.value;
  return ok(document ? { kind: job.event, payload: document } : undefined);
};

/**
 * Tell one page of the author's local followers about the entry, each with
 * the document rendered for it. Redoing a page only sends the events again,
 * which clients take as the same status. Resolves to the cursor of the next
 * page, or `undefined` when this was the last.
 */
export const fanOutHomePage = async (
  env: Env,
  identity: InstanceIdentity,
  job: FanOutHome,
  pageSize: number = HOME_FAN_OUT_PAGE_SIZE,
): Promise<Result<string | undefined, RepositoryError>> => {
  const page = await runD1(() =>
    queryTyped<{ account_id: string }>(
      env.DB,
      listHomeFanOutAccounts(
        job.author.kind === "LocalAccount" ? job.author.accountId : "",
        job.author.kind === "RemoteActor" ? job.author.actorUri : "",
        job.afterAccountId,
        pageSize,
      ),
    ),
  );
  if (page.isErr()) {
    return err(page.error);
  }
  for (const { account_id: accountId } of page.value) {
    const event = await followerEvent(env, identity, job, accountId);
    if (event.isErr()) {
      return err(event.error);
    }
    if (event.value) {
      try {
        await publishToAccount(env, accountId, event.value);
      } catch {
        console.error(JSON.stringify({ kind: "HomeFanOutNotPublished", accountId }));
      }
    }
  }
  const last = page.value.at(-1);
  return ok(page.value.length >= pageSize ? last?.account_id : undefined);
};

/** Handle one queued page of a home fan-out, queueing the next when there is one. */
export const processFanOutHomeJob = async (env: Env, job: FanOutHome): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const next = await fanOutHomePage(env, identity.value, job);
  if (next.isErr()) {
    return "retry";
  }
  if (next.value !== undefined) {
    try {
      await env.OUTBOX_PROCESS_QUEUE.send({ ...job, afterAccountId: next.value });
    } catch {
      console.error(JSON.stringify({ kind: "HomeFanOutNotQueued", entryId: job.entryId }));
    }
  }
  return "ok";
};
