import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { IsoInstant } from "./iso-instant";

/**
 * The activity a local status still owes remote servers because it could
 * not be built when the status was stored or edited (FED-14). A `Create`
 * outranks an `Update`: the edit of a status that never reached them goes as
 * its `Create`.
 */
export const OwedStatusActivitySchema = z.literal(["Create", "Update"]);

export type OwedStatusActivity = z.infer<typeof OwedStatusActivitySchema>;

export const PendingStatusFederationSchema = z.object({
  statusId: z.string().min(1),
  activity: OwedStatusActivitySchema,
  /** Changes with each change of the status while the activity waits. */
  revision: z.number().int().min(0),
  /** The tries that failed so far, the first one included. */
  attempts: z.number().int().min(1),
  nextAttemptAt: IsoInstant.schema,
});

export type PendingStatusFederation = z.infer<typeof PendingStatusFederationSchema>;

/** What follows a failed try. */
export type PendingFederationRetry =
  | Readonly<{ kind: "Retry"; delaySeconds: number }>
  | Readonly<{ kind: "GiveUp" }>;

/** Tries before the activity is given up: about two and a half days of them. */
const MAX_ATTEMPTS = 12;

/** The longest delay a Queues message takes. */
const MAX_DELAY_SECONDS = 12 * 60 * 60;

export const PendingStatusFederation = {
  schema: PendingStatusFederationSchema,
  parse: schemaResult(PendingStatusFederationSchema),
  maxAttempts: MAX_ATTEMPTS,
  /**
   * After `attempts` failed tries: the next one after Sidekiq's
   * `ExponentialBackoff` without its random part (`15 + 10n⁴` seconds, at
   * most 12 hours), or none once {@link MAX_ATTEMPTS} have failed.
   */
  afterFailure: (attempts: number): PendingFederationRetry =>
    attempts >= MAX_ATTEMPTS
      ? { kind: "GiveUp" }
      : { kind: "Retry", delaySeconds: Math.min(15 + 10 * attempts ** 4, MAX_DELAY_SECONDS) },
} as const;
