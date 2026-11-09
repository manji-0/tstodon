import { err, ok, type Result } from "neverthrow";
import { DELIVERY_GIVE_UP_AFTER_MS } from "./outbox-delivery";
import type { RepositoryError } from "./repository-error";

/**
 * A `Queued` delivery target whose next attempt was due before the sweep's
 * cutoff: its Workflow never started, errored, or is late.
 */
export type StuckDeliveryTarget = Readonly<{
  activityId: string;
  inboxUrl: string;
  attemptCount: number;
  /** When the target row was created (ISO instant). */
  createdAt: string;
}>;

/**
 * Where the target's delivery Workflow instance stands: `Missing` (never
 * created, or past its retention), `Ended` (errored, terminated, or complete
 * without settling the row), or `Active` (queued, running, sleeping, paused).
 */
export type DeliveryInstanceState = "Missing" | "Ended" | "Active";

export type StuckDeliveryAction = "Create" | "Restart" | "Wait" | "GiveUp";

/** Up to `limit` `Queued` targets whose next attempt was due before `dueBefore`, oldest first. */
export type ListStuckDeliveries = (
  dueBefore: string,
  limit: number,
) => Promise<Result<ReadonlyArray<StuckDeliveryTarget>, RepositoryError>>;

export type StuckDeliveryDeps = Readonly<{
  list: ListStuckDeliveries;
  instanceState: (target: StuckDeliveryTarget) => Promise<DeliveryInstanceState>;
  /** Start a Workflow instance for the target; false when that failed. */
  create: (target: StuckDeliveryTarget) => Promise<boolean>;
  /** Restart the target's ended instance from its first step; false when that failed. */
  restart: (target: StuckDeliveryTarget) => Promise<boolean>;
  /** Push the target's next-attempt time to `atIso`, so the next sweep looks again later. */
  postpone: (target: StuckDeliveryTarget, atIso: string) => Promise<Result<void, RepositoryError>>;
  /** Mark the target `Failed` / `RetryExhausted`. */
  giveUp: (target: StuckDeliveryTarget) => Promise<Result<void, RepositoryError>>;
}>;

export type StuckDeliverySweep = Readonly<{
  examined: number;
  created: number;
  restarted: number;
  waiting: number;
  givenUp: number;
  /** Targets whose create or restart failed; tried again by the next sweep. */
  failed: number;
}>;

/** A next attempt this late (1 hour) is stuck; a sleeping Workflow wakes well within it. */
const GRACE_MS = 60 * 60 * 1000;

/** Targets per sweep: each costs a Workflows call or two. */
const BATCH = 50;

const action = (
  target: StuckDeliveryTarget,
  state: DeliveryInstanceState,
  nowMs: number,
): StuckDeliveryAction => {
  if (nowMs - Date.parse(target.createdAt) > DELIVERY_GIVE_UP_AFTER_MS) {
    return "GiveUp";
  }
  switch (state) {
    case "Missing":
      return "Create";
    case "Ended":
      return "Restart";
    case "Active":
      return "Wait";
  }
};

export const StuckDelivery = {
  graceMs: GRACE_MS,
  batch: BATCH,
  /** Targets whose next attempt was due before this instant are examined. */
  cutoff: (nowMs: number): string => new Date(nowMs - GRACE_MS).toISOString(),
  /** What the sweep does with one stuck target. */
  action,

  /**
   * One sweep: start the Workflow a target never got (`OutboxWorkflowCreateFailed`),
   * restart one that errored in a step, leave a running one for an hour more,
   * and give up a target older than the retry span could explain.
   */
  sweep: async (
    deps: StuckDeliveryDeps,
    nowMs: number,
  ): Promise<Result<StuckDeliverySweep, RepositoryError>> => {
    const listed = await deps.list(StuckDelivery.cutoff(nowMs), BATCH);
    if (listed.isErr()) {
      return err(listed.error);
    }
    const counts = { examined: 0, created: 0, restarted: 0, waiting: 0, givenUp: 0, failed: 0 };
    for (const target of listed.value) {
      counts.examined += 1;
      // A target past the give-up age is settled without asking Workflows.
      const next =
        nowMs - Date.parse(target.createdAt) > DELIVERY_GIVE_UP_AFTER_MS
          ? "GiveUp"
          : action(target, await deps.instanceState(target), nowMs);
      switch (next) {
        case "GiveUp": {
          const given = await deps.giveUp(target);
          if (given.isErr()) {
            return err(given.error);
          }
          counts.givenUp += 1;
          break;
        }
        case "Wait": {
          const postponed = await deps.postpone(target, new Date(nowMs).toISOString());
          if (postponed.isErr()) {
            return err(postponed.error);
          }
          counts.waiting += 1;
          break;
        }
        case "Create":
        case "Restart": {
          const started =
            next === "Create" ? await deps.create(target) : await deps.restart(target);
          // The started Workflow settles the row; until it does (or after a
          // failed start), look again after the grace, behind older targets.
          const postponed = await deps.postpone(target, new Date(nowMs).toISOString());
          if (postponed.isErr()) {
            return err(postponed.error);
          }
          if (!started) {
            counts.failed += 1;
          } else if (next === "Create") {
            counts.created += 1;
          } else {
            counts.restarted += 1;
          }
          break;
        }
      }
    }
    return ok(counts);
  },
} as const;
