import { schemaResult, warmSchemas } from "@tstodon/core";
import {
  DeliveryAttemptOutcome,
  type DeliveryReachability,
  Hostname,
  OutboxDelivery,
  type OutboxDeliveryValue,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";
import type { InboxDeliveryAttempt, InboxPost } from "./delivery";
import { parseJsonText } from "./json-column";
import type { DueOutboxTarget, NextOutboxTargetDue, SettledOutboxTarget } from "./outbox-store";

/**
 * The targets one Workflow instance delivers: every `Queued` target of the
 * activity, or only `inboxUrl`'s for an instance started per inbox before
 * deliveries were grouped by activity.
 */
export type DeliveryScope = Readonly<{ activityId: string; inboxUrl: string | null }>;

/** The two `WorkflowStep` calls the delivery uses; a step's result is JSON text. */
export type DeliverySteps = Readonly<{
  run: (name: string, work: () => Promise<string>) => Promise<string>;
  sleepUntil: (name: string, atMs: number) => Promise<void>;
}>;

export type DeliveryRunDeps = Readonly<{
  dueTargets: (
    scope: DeliveryScope,
    afterInboxUrl: string,
    dueBy: string,
    limit: number,
  ) => Promise<Result<ReadonlyArray<DueOutboxTarget>, RepositoryError>>;
  nextDue: (scope: DeliveryScope) => Promise<Result<NextOutboxTargetDue, RepositoryError>>;
  /** Whether the inbox's domain is marked unavailable. */
  domainUnavailable: (inboxUrl: string) => Promise<boolean>;
  prepare: (activityId: string) => Promise<InboxPost>;
  persist: (
    activityId: string,
    settled: ReadonlyArray<SettledOutboxTarget>,
  ) => Promise<Result<void, RepositoryError>>;
  recordReachability: (inboxUrl: string, reachability: DeliveryReachability) => Promise<unknown>;
  metric: (index: string, doubles: ReadonlyArray<number>, blobs: ReadonlyArray<string>) => void;
  now: () => number;
  random: () => number;
}>;

export type DeliveryRunResult =
  | Readonly<{ kind: "Settled"; rounds: number }>
  /** Left for the stuck-delivery sweep to restart. */
  | Readonly<{ kind: "StepBudgetSpent" }>
  | Readonly<{ kind: "InvalidJob" }>;

/** Inboxes per step: one D1 read of the due targets, one of the activity, one batched write. */
export const DELIVERY_CHUNK = 10;

/**
 * Targets due this close after the earliest are attempted with it, so the
 * targets that failed together are retried in one step. Under the shortest
 * backoff (15 s), so a target attempted in a round is never due again in it.
 */
const DUE_SLACK_MS = 10_000;

/** `step.do` calls per run; the stuck-delivery sweep restarts an instance that ran out. */
const MAX_STEPS = 1_000;

const ChunkOutcomeSchema = z.discriminatedUnion("kind", [
  /** More targets are due in this round, after `cursor`. */
  z.object({ kind: z.literal("More"), cursor: z.string().min(1) }),
  /** No target is `Queued` any more. */
  z.object({ kind: z.literal("Settled") }),
  /** Sleep until `wakeAtMs`, then attempt the targets due by `dueBy`. */
  z.object({ kind: z.literal("Wait"), wakeAtMs: z.number(), dueBy: z.string().min(1) }),
]);

type ChunkOutcome = z.infer<typeof ChunkOutcomeSchema>;

const parseOutcome = (raw: string): ChunkOutcome | undefined => {
  const json = parseJsonText(raw);
  if (json.isErr()) {
    return undefined;
  }
  const parsed = schemaResult(ChunkOutcomeSchema)(json.value);
  return parsed.isOk() ? parsed.value : undefined;
};

const hostLabel = (inboxUrl: string): string => Hostname.ofUri(inboxUrl) ?? "";

const logGivenUp = (
  activityId: string,
  inboxUrl: string,
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
      activityId,
      inboxUrl,
      attempts: next.reasonKind === "RetryExhausted" ? next.attemptCount : undefined,
      lastOutcome: DeliveryAttemptOutcome.label(outcome),
      httpStatus: DeliveryAttemptOutcome.failedHttpStatus(outcome),
    }),
  );
};

type Attempted = Readonly<{
  target: DueOutboxTarget;
  made: InboxDeliveryAttempt;
  latencyMs: number;
  next: OutboxDeliveryValue;
}>;

/** Where the round goes after its last chunk: done, or asleep until the next target is due. */
const afterRound = async (deps: DeliveryRunDeps, scope: DeliveryScope): Promise<ChunkOutcome> => {
  const next = await deps.nextDue(scope);
  if (next.isErr()) {
    throw new Error(next.error.message);
  }
  const now = deps.now();
  switch (next.value.kind) {
    case "None":
      return { kind: "Settled" };
    case "Now":
      return { kind: "Wait", wakeAtMs: now, dueBy: new Date(now + DUE_SLACK_MS).toISOString() };
    case "At": {
      const wakeAtMs = Date.parse(next.value.at);
      return {
        kind: "Wait",
        wakeAtMs,
        dueBy: new Date(Math.max(wakeAtMs, now) + DUE_SLACK_MS).toISOString(),
      };
    }
  }
};

/**
 * One step: attempt up to {@link DELIVERY_CHUNK} due targets after `cursor`
 * at once, store each one's state in one write, and record what each answer
 * says about its domain. Run again after a failure (a D1 error), it finds
 * only the targets still due: a target settled or rescheduled before the
 * failure is not posted again.
 */
const deliverChunk = async (
  deps: DeliveryRunDeps,
  scope: DeliveryScope,
  cursor: string,
  dueBy: string,
): Promise<ChunkOutcome> => {
  const listed = await deps.dueTargets(scope, cursor, dueBy, DELIVERY_CHUNK + 1);
  if (listed.isErr()) {
    throw new Error(listed.error.message);
  }
  const targets = listed.value.slice(0, DELIVERY_CHUNK);
  // One at a time: the first call may load the isolate's domain health copy.
  const unavailable: boolean[] = [];
  for (const target of targets) {
    unavailable.push(await deps.domainUnavailable(target.inboxUrl));
  }
  const skipped = targets.filter((_, index) => unavailable[index]);
  const due = targets.filter((_, index) => !unavailable[index]);
  const post = due.length > 0 ? await deps.prepare(scope.activityId) : undefined;
  const attempted: Attempted[] =
    post === undefined
      ? []
      : await Promise.all(
          due.map(async (target) => {
            const startedAt = deps.now();
            const made = await post(target.inboxUrl);
            const next = OutboxDelivery.afterAttempt(
              { kind: "Queued", attemptCount: target.attemptCount },
              made.outcome,
            );
            return { target, made, latencyMs: Math.max(0, deps.now() - startedAt), next };
          }),
        );
  const settled: SettledOutboxTarget[] = [
    ...skipped.map((target) => ({
      inboxUrl: target.inboxUrl,
      delivery: OutboxDelivery.skipped(),
      nextAttemptAt: null,
      lastHttpStatus: null,
    })),
    ...attempted.map(({ target, made, next }) => {
      const failedStatus = DeliveryAttemptOutcome.failedHttpStatus(made.outcome);
      return {
        inboxUrl: target.inboxUrl,
        delivery: next,
        nextAttemptAt:
          next.kind === "Queued"
            ? new Date(
                deps.now() + OutboxDelivery.nextDelayMs(next, made.outcome, deps.random()),
              ).toISOString()
            : null,
        lastHttpStatus: failedStatus === 0 ? null : failedStatus,
      };
    }),
  ];
  const persisted = await deps.persist(scope.activityId, settled);
  if (persisted.isErr()) {
    throw new Error(persisted.error.message);
  }
  for (const target of skipped) {
    console.log(
      JSON.stringify({
        kind: "OutboxDeliverySkipped",
        activityId: scope.activityId,
        reason: "DomainUnavailable",
        targets: 1,
        domains: [hostLabel(target.inboxUrl)],
      }),
    );
    // One `outbox.deliver` point per attempt: doubles `[latencyMs, failedHttpStatus, attemptNumber]`, blobs `[outcome, host]`.
    deps.metric(
      "outbox.deliver",
      [0, 0, target.attemptCount],
      ["skipped", hostLabel(target.inboxUrl)],
    );
  }
  for (const { target, made, latencyMs, next } of attempted) {
    deps.metric(
      "outbox.deliver",
      [latencyMs, DeliveryAttemptOutcome.failedHttpStatus(made.outcome), target.attemptCount + 1],
      [DeliveryAttemptOutcome.label(made.outcome), hostLabel(target.inboxUrl)],
    );
    if (made.remote) {
      await deps.recordReachability(
        target.inboxUrl,
        DeliveryAttemptOutcome.reachability(made.outcome),
      );
    }
    logGivenUp(scope.activityId, target.inboxUrl, next, made.outcome);
  }
  const last = targets.at(-1);
  return listed.value.length > DELIVERY_CHUNK && last !== undefined
    ? { kind: "More", cursor: last.inboxUrl }
    : afterRound(deps, scope);
};

/**
 * The delivery of one activity, as `OutboxDeliveryWorkflow` runs it, in
 * rounds. A round attempts every target due by then, {@link DELIVERY_CHUNK}
 * to a step, in inbox order; each target that failed is rescheduled on its
 * own Sidekiq backoff (or a longer `Retry-After`), up to
 * `DELIVERY_MAX_ATTEMPTS` attempts. The instance then sleeps until the next
 * target is due and starts the next round, until no target is `Queued`.
 * Round 0 attempts only targets never attempted; a later round, those due
 * by the time the previous one set (`DUE_SLACK_MS`). The rows drive the
 * loop, so a restarted instance carries on where they left off. Step names
 * are stable per round and chunk, as Workflows replays a step by name.
 */
export const runOutboxDelivery = async (
  steps: DeliverySteps,
  deps: DeliveryRunDeps,
  scope: DeliveryScope,
): Promise<DeliveryRunResult> => {
  let round = 0;
  let chunk = 0;
  let cursor = "";
  // No ISO instant sorts at or before "": round 0 sees only targets never attempted.
  let dueBy = "";
  for (let taken = 0; taken < MAX_STEPS; taken += 1) {
    const outcome = parseOutcome(
      await steps.run(`round-${round}-chunk-${chunk}`, async () =>
        JSON.stringify(await deliverChunk(deps, scope, cursor, dueBy)),
      ),
    );
    if (outcome === undefined) {
      return { kind: "InvalidJob" };
    }
    switch (outcome.kind) {
      case "More":
        cursor = outcome.cursor;
        chunk += 1;
        break;
      case "Settled":
        return { kind: "Settled", rounds: round + 1 };
      case "Wait":
        await steps.sleepUntil(`round-${round}-wait`, outcome.wakeAtMs);
        round += 1;
        chunk = 0;
        cursor = "";
        dueBy = outcome.dueBy;
        break;
    }
  }
  return { kind: "StepBudgetSpent" };
};

warmSchemas([ChunkOutcomeSchema]);
