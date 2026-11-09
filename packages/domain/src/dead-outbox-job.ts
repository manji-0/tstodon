import { assertNever, schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { type DeadOutboxJobSelection, OutboxJob } from "./outbox-job";
import type { RepositoryError } from "./repository-error";

/**
 * What the outbox queue handler sends to the dead-letter queue when a job
 * returned retry on its last attempt: the message body as it was queued,
 * and how many times it ran.
 */
const DeadLetterEnvelopeSchema = z.object({
  kind: z.literal("DeadOutboxJob"),
  job: z.unknown(),
  attempts: z.number().int().positive(),
});

export type DeadLetterEnvelope = Readonly<{
  kind: "DeadOutboxJob";
  job: unknown;
  attempts: number;
}>;

/**
 * Why a job reached the dead-letter queue. `RetriesExhausted`: the job
 * returned retry on its last attempt and the handler sent it. `HandlerFailed`:
 * Queues dead-lettered a valid job after `max_retries` (the handler threw, or
 * the invocation ran out of time or memory). `Unparseable`: the body is not
 * an `OutboxJob` (a hand-sent message, or a job kind this build does not know).
 */
const DeadReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RetriesExhausted") }),
  z.object({ kind: z.literal("HandlerFailed") }),
  z.object({ kind: z.literal("Unparseable"), issues: z.string() }),
]);

export type DeadReason = z.infer<typeof DeadReasonSchema>;

/** One dead job, as the dead-letter consumer stores it. */
export type DeadOutboxJobEntry = Readonly<{
  /** The body's `kind`, or `Unknown` for a body without one. */
  jobKind: string;
  /** The job as queued: what a requeue sends back. */
  body: unknown;
  /** How many times the outbox queue delivered it before it died. */
  attempts: number;
  reason: DeadReason;
}>;

/**
 * Store a dead job, or count it again when the same body is already stored.
 * Resolves to the row id.
 */
export type RecordDeadOutboxJob = (
  entry: DeadOutboxJobEntry,
  seenAt: string,
) => Promise<Result<string, RepositoryError>>;

/** A stored dead job: its id (the digest of its body) and the body to requeue. */
export type DeadOutboxJobRow = Readonly<{ id: string; body: unknown }>;

/**
 * Up to `limit` of the stored dead jobs `select` names that were last seen
 * at or before `seenBefore`, oldest first.
 */
export type ListDeadOutboxJobs = (
  select: DeadOutboxJobSelection,
  seenBefore: string,
  limit: number,
) => Promise<Result<ReadonlyArray<DeadOutboxJobRow>, RepositoryError>>;

/** Remove stored dead jobs by id. */
export type DeleteDeadOutboxJobs = (
  ids: ReadonlyArray<string>,
) => Promise<Result<void, RepositoryError>>;

/** Put job bodies back on the outbox queue; rejects when the queue refuses them. */
export type SendOutboxJobs = (bodies: ReadonlyArray<unknown>) => Promise<void>;

/** What one requeue page did, and whether a full page asks for the next. */
export type DeadOutboxJobRequeuePage = Readonly<{ requeued: number; chained: boolean }>;

/** Rows per requeue page (a queue `sendBatch` takes at most 100 messages). */
const REQUEUE_PAGE = 50;

const kindOf = (body: unknown): string => {
  if (typeof body !== "object" || body === null) {
    return "Unknown";
  }
  const kind: unknown = Reflect.get(body, "kind");
  return typeof kind === "string" && kind.length > 0 ? kind.slice(0, 100) : "Unknown";
};

const parseEnvelope = schemaResult(DeadLetterEnvelopeSchema);

const issuesOf = (body: unknown): string | undefined => {
  const parsed = OutboxJob.parse(body);
  return parsed.isOk()
    ? undefined
    : parsed.error.issues
        .map((issue) => `${issue.path?.map(String).join(".") || "(body)"}: ${issue.message}`)
        .join("; ")
        .slice(0, 1000);
};

export const DeadOutboxJob = {
  requeuePage: REQUEUE_PAGE,

  /** The message the handler sends to the dead-letter queue for a job it gives up on. */
  envelope: (job: unknown, attempts: number): DeadLetterEnvelope => ({
    kind: "DeadOutboxJob",
    job,
    attempts,
  }),

  /**
   * Read a dead-letter message: the handler's envelope, or a body Queues
   * moved here itself after `queueAttempts` deliveries (`max_retries` + 1).
   */
  classify: (message: unknown, queueAttempts: number): DeadOutboxJobEntry => {
    const envelope = parseEnvelope(message);
    const { body, attempts, handlerSent } = envelope.isOk()
      ? { body: envelope.value.job, attempts: envelope.value.attempts, handlerSent: true }
      : { body: message, attempts: queueAttempts, handlerSent: false };
    const issues = issuesOf(body);
    const reason: DeadReason =
      issues !== undefined
        ? { kind: "Unparseable", issues }
        : handlerSent
          ? { kind: "RetriesExhausted" }
          : { kind: "HandlerFailed" };
    return { jobKind: kindOf(body), body, attempts, reason };
  },

  /** The `error` column: a line an operator reads beside the job. */
  describe: (entry: DeadOutboxJobEntry): string => {
    const { reason } = entry;
    switch (reason.kind) {
      case "RetriesExhausted":
        return `returned retry on each of ${entry.attempts} attempts`;
      case "HandlerFailed":
        return `dead-lettered by Queues after ${entry.attempts} attempts: the handler threw or the invocation failed`;
      case "Unparseable":
        return `not an OutboxJob: ${reason.issues}`;
      default:
        return assertNever(reason);
    }
  },

  /**
   * One requeue page: list the next stored jobs, send them back, then delete
   * their rows. Sending first means a failed delete leaves a row that a later
   * requeue sends again, never a job that is neither queued nor stored.
   */
  requeue: async (
    deps: Readonly<{
      list: ListDeadOutboxJobs;
      send: SendOutboxJobs;
      remove: DeleteDeadOutboxJobs;
    }>,
    select: DeadOutboxJobSelection,
    seenBefore: string,
  ): Promise<Result<DeadOutboxJobRequeuePage, RepositoryError>> => {
    const listed = await deps.list(select, seenBefore, REQUEUE_PAGE);
    if (listed.isErr()) {
      return err(listed.error);
    }
    const rows = listed.value;
    if (rows.length === 0) {
      return ok({ requeued: 0, chained: false });
    }
    await deps.send(rows.map((row) => row.body));
    const removed = await deps.remove(rows.map((row) => row.id));
    if (removed.isErr()) {
      return err(removed.error);
    }
    return ok({ requeued: rows.length, chained: rows.length >= REQUEUE_PAGE });
  },
} as const;
