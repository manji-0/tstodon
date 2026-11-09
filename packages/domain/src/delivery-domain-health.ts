import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { DeliveryReachability } from "./delivery-attempt-outcome";
import { Hostname } from "./hostname";
import type { RepositoryError } from "./repository-error";

/**
 * Mastodon's `DeliveryFailureTracker::FAILURE_DAYS_THRESHOLD`: a domain that
 * failed deliveries on this many distinct days, with no success between, is
 * unavailable.
 */
export const DELIVERY_FAILURE_DAYS_THRESHOLD = 7;

const DaySchema = z.iso.date();

const FailingSchema = z.object({
  kind: z.literal("Failing"),
  domain: Hostname.schema,
  /** Distinct UTC days with a failed delivery since the last success. */
  failureDays: z.number().int().positive(),
  /** The last of those days, `YYYY-MM-DD`. */
  lastFailureDay: DaySchema,
});

const UnavailableSchema = z.object({
  kind: z.literal("Unavailable"),
  domain: Hostname.schema,
  failureDays: z.number().int().positive(),
  lastFailureDay: DaySchema,
  /** When the threshold was reached (ISO instant). */
  unavailableSince: z.iso.datetime(),
});

/**
 * A remote domain that deliveries have been failing to: Mastodon's
 * `DeliveryFailureTracker` days and its `UnavailableDomain`, kept per domain
 * (Mastodon keeps the days per inbox URL and the unavailable mark per domain).
 * A domain with no failures has no health record.
 */
export const DeliveryDomainHealthSchema = z.discriminatedUnion("kind", [
  FailingSchema,
  UnavailableSchema,
]);

export type DeliveryDomainHealth = z.infer<typeof DeliveryDomainHealthSchema>;

/** What recording one delivery outcome (or an inbound contact) changed. */
export type DeliveryDomainChange =
  | Readonly<{ kind: "Unchanged" }>
  | Readonly<{ kind: "FailureDayRecorded"; failureDays: number }>
  | Readonly<{ kind: "BecameUnavailable"; failureDays: number }>
  | Readonly<{ kind: "Cleared"; wasUnavailable: boolean; failureDays: number }>;

/** The stored health of `domain`, read from D1 now. */
export type FindDeliveryDomainHealth = (
  domain: Hostname,
) => Promise<Result<DeliveryDomainHealth | undefined, RepositoryError>>;

/**
 * The health of `domain` as this isolate last read it: may be a little stale,
 * so it decides only whether a write is needed, never what to write.
 */
export type FindCachedDeliveryDomainHealth = (
  domain: Hostname,
) => Promise<DeliveryDomainHealth | undefined>;

/** Insert or replace the domain's health record. */
export type SaveDeliveryDomainHealth = (
  health: DeliveryDomainHealth,
) => Promise<Result<void, RepositoryError>>;

/** Delete the domain's health record: it is available again. */
export type ClearDeliveryDomainHealth = (
  domain: Hostname,
) => Promise<Result<void, RepositoryError>>;

export type DeliveryDomainHealthDeps = Readonly<{
  cached: FindCachedDeliveryDomainHealth;
  find: FindDeliveryDomainHealth;
  save: SaveDeliveryDomainHealth;
  clear: ClearDeliveryDomainHealth;
}>;

const dayOf = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

const afterFailure = (
  current: DeliveryDomainHealth | undefined,
  domain: Hostname,
  nowMs: number,
): Readonly<{ health: DeliveryDomainHealth; change: DeliveryDomainChange }> | undefined => {
  const today = dayOf(nowMs);
  if (current === undefined) {
    return {
      health: { kind: "Failing", domain, failureDays: 1, lastFailureDay: today },
      change: { kind: "FailureDayRecorded", failureDays: 1 },
    };
  }
  if (current.lastFailureDay >= today) {
    return undefined;
  }
  const failureDays = current.failureDays + 1;
  if (current.kind === "Unavailable") {
    return {
      health: { ...current, failureDays, lastFailureDay: today },
      change: { kind: "FailureDayRecorded", failureDays },
    };
  }
  if (failureDays >= DELIVERY_FAILURE_DAYS_THRESHOLD) {
    return {
      health: {
        kind: "Unavailable",
        domain: current.domain,
        failureDays,
        lastFailureDay: today,
        unavailableSince: new Date(nowMs).toISOString(),
      },
      change: { kind: "BecameUnavailable", failureDays },
    };
  }
  return {
    health: { ...current, failureDays, lastFailureDay: today },
    change: { kind: "FailureDayRecorded", failureDays },
  };
};

export const DeliveryDomainHealth = {
  schema: DeliveryDomainHealthSchema,
  parse: schemaResult(DeliveryDomainHealthSchema),
  threshold: DELIVERY_FAILURE_DAYS_THRESHOLD,
  /** The UTC day of an instant, `YYYY-MM-DD`: the unit failures are counted in. */
  dayOf,
  /**
   * The record after a failed delivery at `nowMs`, and what changed;
   * `undefined` when a failure was already recorded that day.
   */
  afterFailure,
  isUnavailable: (health: DeliveryDomainHealth | undefined): boolean =>
    health?.kind === "Unavailable",

  /**
   * Record what an attempt, or a verified inbound activity
   * (`Reachable`), says about `domain`. A reachable domain with no record
   * costs no write; a failure on a day already recorded costs none either
   * once this isolate has seen it.
   */
  record: async (
    deps: DeliveryDomainHealthDeps,
    domain: Hostname,
    reachability: DeliveryReachability,
    nowMs: number,
  ): Promise<Result<DeliveryDomainChange, RepositoryError>> => {
    switch (reachability) {
      case "Unknown":
        return ok({ kind: "Unchanged" });
      case "Reachable": {
        const tracked = await deps.cached(domain);
        if (tracked === undefined) {
          return ok({ kind: "Unchanged" });
        }
        const cleared = await deps.clear(domain);
        return cleared.isErr()
          ? err(cleared.error)
          : ok({
              kind: "Cleared",
              wasUnavailable: tracked.kind === "Unavailable",
              failureDays: tracked.failureDays,
            });
      }
      case "Unreachable": {
        const tracked = await deps.cached(domain);
        if (tracked !== undefined && tracked.lastFailureDay >= dayOf(nowMs)) {
          return ok({ kind: "Unchanged" });
        }
        const current = await deps.find(domain);
        if (current.isErr()) {
          return err(current.error);
        }
        const next = afterFailure(current.value, domain, nowMs);
        if (next === undefined) {
          return ok({ kind: "Unchanged" });
        }
        const saved = await deps.save(next.health);
        return saved.isErr() ? err(saved.error) : ok(next.change);
      }
    }
  },
} as const;
