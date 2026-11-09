import { schemaResult, warmSchemas } from "@tstodon/core";
import {
  DELIVERY_MAX_ATTEMPTS,
  DeliveryAttemptOutcome,
  type DeliveryReachability,
  Hostname,
  OutboxDelivery,
  type OutboxDeliveryValue,
  type OutboxJob,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";
import type { InboxDeliveryAttempt } from "./delivery";
import { parseJsonText } from "./json-column";

type DeliverTargetJob = Extract<OutboxJob, { kind: "DeliverTarget" }>;

/**
 * How a step may be retried by the Workflow: `read` and `write` are D1 work
 * that is safe to run again; `post` is the inbox POST, never retried by the
 * step (a failed attempt is counted and retried after the backoff instead).
 */
export type DeliveryStepKind = "read" | "post" | "write";

/** The two `WorkflowStep` calls the delivery uses; results are JSON text. */
export type DeliverySteps = Readonly<{
  run: (name: string, kind: DeliveryStepKind, work: () => Promise<string>) => Promise<string>;
  sleep: (name: string, ms: number) => Promise<void>;
}>;

export type DeliveryRunDeps = Readonly<{
  /** The target row, inserted `Queued` when missing. */
  load: (job: DeliverTargetJob) => Promise<Result<OutboxDeliveryValue, RepositoryError>>;
  /** Whether the inbox's domain is marked unavailable. */
  domainUnavailable: (inboxUrl: string) => Promise<boolean>;
  attempt: (job: DeliverTargetJob) => Promise<InboxDeliveryAttempt>;
  persist: (
    job: DeliverTargetJob,
    delivery: OutboxDeliveryValue,
    nextAttemptAt: string | null,
  ) => Promise<Result<void, RepositoryError>>;
  recordReachability: (inboxUrl: string, reachability: DeliveryReachability) => Promise<unknown>;
  metric: (index: string, doubles: ReadonlyArray<number>, blobs: ReadonlyArray<string>) => void;
  now: () => number;
  random: () => number;
}>;

export type DeliveryRunResult = OutboxDeliveryValue | Readonly<{ kind: "InvalidJob" }>;

const LoadedSchema = z.object({
  delivery: OutboxDelivery.schema,
  domainUnavailable: z.boolean(),
});
const AttemptSchema = z.object({
  outcome: DeliveryAttemptOutcome.schema,
  remote: z.boolean(),
});
const SavedSchema = z.object({
  next: OutboxDelivery.schema,
  delayMs: z.number().nonnegative(),
});

const parseStep = <T>(schema: z.ZodType<T>, raw: string): T | undefined => {
  const json = parseJsonText(raw);
  if (json.isErr()) {
    return undefined;
  }
  const parsed = schemaResult(schema)(json.value);
  return parsed.isOk() ? parsed.value : undefined;
};

const hostLabel = (inboxUrl: string): string => Hostname.ofUri(inboxUrl) ?? "";

/** One point per attempt: `outbox.deliver`, doubles `[latencyMs, failedHttpStatus, attemptNumber]`, blobs `[outcome, host]`. */
const attemptMetric = (
  deps: DeliveryRunDeps,
  job: DeliverTargetJob,
  label: string,
  latencyMs: number,
  httpStatus: number,
  attemptNumber: number,
): void => {
  deps.metric(
    "outbox.deliver",
    [latencyMs, httpStatus, attemptNumber],
    [label, hostLabel(job.inboxUrl)],
  );
};

const logGivenUp = (
  job: DeliverTargetJob,
  next: OutboxDeliveryValue,
  outcome: DeliveryAttemptOutcome,
): void => {
  if (next.kind !== "Failed") {
    return;
  }
  console.warn(
    JSON.stringify({
      kind: "OutboxDeliveryGivenUp",
      reasonKind: next.reasonKind,
      activityId: job.activityId,
      inboxUrl: job.inboxUrl,
      attempts: next.reasonKind === "RetryExhausted" ? next.attemptCount : undefined,
      lastOutcome: DeliveryAttemptOutcome.label(outcome),
      httpStatus: DeliveryAttemptOutcome.failedHttpStatus(outcome),
    }),
  );
};

/**
 * The delivery of one activity to one inbox, as `OutboxDeliveryWorkflow`
 * runs it: up to {@link DELIVERY_MAX_ATTEMPTS} attempts, Sidekiq's backoff
 * (or a longer `Retry-After`) slept between them, the target row settled
 * after each, and the inbox's domain health recorded. The loop is driven by
 * the row's attempt count, so a restarted instance carries on where the row
 * left off. Step names are stable per iteration, as Workflows replays a step
 * by name.
 */
export const runOutboxDelivery = async (
  steps: DeliverySteps,
  deps: DeliveryRunDeps,
  job: DeliverTargetJob,
): Promise<DeliveryRunResult> => {
  for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i += 1) {
    const loaded = parseStep(
      LoadedSchema,
      await steps.run(`attempt-${i}-load`, "read", async () => {
        const target = await deps.load(job);
        if (target.isErr()) {
          throw new Error(target.error.message);
        }
        const domainUnavailable =
          target.value.kind === "Queued" ? await deps.domainUnavailable(job.inboxUrl) : false;
        return JSON.stringify({ delivery: target.value, domainUnavailable });
      }),
    );
    if (loaded === undefined) {
      return { kind: "InvalidJob" };
    }
    const slot = loaded.delivery;
    if (slot.kind !== "Queued") {
      return slot;
    }
    if (loaded.domainUnavailable) {
      const skipped = OutboxDelivery.skipped();
      await steps.run(`attempt-${i}-skip`, "write", async () => {
        const persisted = await deps.persist(job, skipped, null);
        if (persisted.isErr()) {
          throw new Error(persisted.error.message);
        }
        console.log(
          JSON.stringify({
            kind: "OutboxDeliverySkipped",
            activityId: job.activityId,
            reason: "DomainUnavailable",
            targets: 1,
            domains: [hostLabel(job.inboxUrl)],
          }),
        );
        attemptMetric(deps, job, "skipped", 0, 0, slot.attemptCount);
        return skipped.kind;
      });
      return skipped;
    }
    const attempt = parseStep(
      AttemptSchema,
      await steps.run(`attempt-${i}-post`, "post", async () => {
        const startedAt = deps.now();
        const made = await deps.attempt(job);
        attemptMetric(
          deps,
          job,
          DeliveryAttemptOutcome.label(made.outcome),
          Math.max(0, deps.now() - startedAt),
          DeliveryAttemptOutcome.failedHttpStatus(made.outcome),
          slot.attemptCount + 1,
        );
        return JSON.stringify(made);
      }),
    );
    if (attempt === undefined) {
      return { kind: "InvalidJob" };
    }
    const saved = parseStep(
      SavedSchema,
      await steps.run(`attempt-${i}-save`, "write", async () => {
        const next = OutboxDelivery.afterAttempt(slot, attempt.outcome);
        const delayMs =
          next.kind === "Queued"
            ? OutboxDelivery.nextDelayMs(next, attempt.outcome, deps.random())
            : 0;
        const nextAttemptAt =
          next.kind === "Queued" ? new Date(deps.now() + delayMs).toISOString() : null;
        const persisted = await deps.persist(job, next, nextAttemptAt);
        if (persisted.isErr()) {
          throw new Error(persisted.error.message);
        }
        if (attempt.remote) {
          await deps.recordReachability(
            job.inboxUrl,
            DeliveryAttemptOutcome.reachability(attempt.outcome),
          );
        }
        logGivenUp(job, next, attempt.outcome);
        return JSON.stringify({ next, delayMs });
      }),
    );
    if (saved === undefined) {
      return { kind: "InvalidJob" };
    }
    if (saved.next.kind !== "Queued") {
      return saved.next;
    }
    await steps.sleep(`attempt-${i}-backoff`, saved.delayMs);
  }
  return { kind: "Failed", reasonKind: "RetryExhausted", attemptCount: DELIVERY_MAX_ATTEMPTS };
};

warmSchemas([LoadedSchema, AttemptSchema, SavedSchema]);
