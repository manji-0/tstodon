import {
  DELIVERY_MAX_ATTEMPTS,
  type DeliveryInstanceState,
  OutboxJob,
  StuckDelivery,
  type StuckDeliveryDeps,
  type StuckDeliverySweep,
  type StuckDeliveryTarget,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import {
  type DeliveryWorkflowCreate,
  deliveryWorkflowId,
  startOutboxDeliveryWorkflow,
} from "./delivery";
import { writeMetric } from "./metrics";
import { listStuckOutboxTargets, persistOutboxTarget, postponeOutboxTarget } from "./outbox-store";

/** The part of the `OUTBOX_DELIVERY_WORKFLOW` binding the sweep uses. */
export type DeliveryWorkflowInstances = DeliveryWorkflowCreate &
  Readonly<{
    get: (id: string) => Promise<
      Readonly<{
        status: () => Promise<Readonly<{ status: string }>>;
        restart: () => Promise<void>;
      }>
    >;
  }>;

const ENDED = new Set(["errored", "terminated", "complete"]);

const instanceState = async (
  workflows: DeliveryWorkflowInstances,
  target: StuckDeliveryTarget,
): Promise<DeliveryInstanceState> => {
  // `get` throws for an id Workflows does not know: never created, or past
  // its retention.
  try {
    const instance = await workflows.get(
      await deliveryWorkflowId(target.activityId, target.inboxUrl),
    );
    const { status } = await instance.status();
    return ENDED.has(status) ? "Ended" : "Active";
  } catch {
    return "Missing";
  }
};

const logFailed = (kind: string, target: StuckDeliveryTarget, cause: unknown): void => {
  console.error(
    JSON.stringify({
      kind,
      activityId: target.activityId,
      inboxUrl: target.inboxUrl,
      message: cause instanceof Error ? cause.message : String(cause),
    }),
  );
};

export const stuckDeliveryDeps = (
  env: Env,
  workflows: DeliveryWorkflowInstances = env.OUTBOX_DELIVERY_WORKFLOW,
): StuckDeliveryDeps => ({
  list: (dueBefore, limit) => listStuckOutboxTargets(env.DB, dueBefore, limit),
  instanceState: (target) => instanceState(workflows, target),
  create: async (target) => {
    const job = OutboxJob.parse({
      kind: "DeliverTarget",
      activityId: target.activityId,
      inboxUrl: target.inboxUrl,
    });
    return job.isOk() && job.value.kind === "DeliverTarget"
      ? startOutboxDeliveryWorkflow(env, job.value, workflows)
      : false;
  },
  restart: async (target) => {
    try {
      const instance = await workflows.get(
        await deliveryWorkflowId(target.activityId, target.inboxUrl),
      );
      await instance.restart();
      return true;
    } catch (cause) {
      logFailed("OutboxWorkflowRestartFailed", target, cause);
      return false;
    }
  },
  postpone: (target, atIso) =>
    postponeOutboxTarget(env.DB, target.activityId, target.inboxUrl, atIso),
  giveUp: async (target) => {
    const given = await persistOutboxTarget(env.DB, target.activityId, target.inboxUrl, {
      kind: "Failed",
      reasonKind: "RetryExhausted",
      attemptCount: Math.max(1, Math.min(target.attemptCount, DELIVERY_MAX_ATTEMPTS)),
    });
    if (given.isOk()) {
      console.warn(
        JSON.stringify({
          kind: "OutboxDeliveryGivenUp",
          reasonKind: "Stuck",
          activityId: target.activityId,
          inboxUrl: target.inboxUrl,
          attempts: target.attemptCount,
        }),
      );
    }
    return given;
  },
});

/**
 * The hourly sweep of `Queued` targets whose next attempt is over an hour
 * late (OPS-6): a Workflow that never started is created, one that errored
 * in a step is restarted, and a target older than any retry schedule is
 * given up. One `outbox.sweep` point per run: doubles
 * `[examined, created, restarted, waiting, givenUp, failed]`.
 */
export const sweepStuckDeliveries = async (
  env: Env,
  deps: StuckDeliveryDeps = stuckDeliveryDeps(env),
  nowMs: number = Date.now(),
): Promise<Result<StuckDeliverySweep, RepositoryError>> => {
  const swept = await StuckDelivery.sweep(deps, nowMs);
  if (swept.isErr()) {
    console.error(
      JSON.stringify({ kind: "OutboxDeliverySweepFailed", message: swept.error.message }),
    );
    writeMetric(env, "outbox.sweep", [0, 0, 0, 0, 0, 0], ["error"]);
    return swept;
  }
  const { examined, created, restarted, waiting, givenUp, failed } = swept.value;
  if (examined > 0) {
    console.log(JSON.stringify({ kind: "OutboxDeliverySweep", ...swept.value }));
  }
  writeMetric(
    env,
    "outbox.sweep",
    [examined, created, restarted, waiting, givenUp, failed],
    ["ok"],
  );
  return swept;
};
