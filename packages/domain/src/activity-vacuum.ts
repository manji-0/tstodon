import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./repository-error";

/** How long a table keeps its rows: a number of days, or no pruning at all. */
const RetentionWindowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Off") }),
  z.object({ kind: z.literal("Days"), days: z.number().int().positive() }),
]);

export type RetentionWindow = z.infer<typeof RetentionWindowSchema>;

/** The retention of each table the activity vacuum prunes. */
export type ActivityRetention = Readonly<{
  deliveries: RetentionWindow;
  outbound: RetentionWindow;
  inbox: RetentionWindow;
}>;

/** The retention vars as set (each may be unset or empty). */
export type ActivityRetentionVars = Readonly<{
  deliveries?: string | undefined;
  outbound?: string | undefined;
  inbox?: string | undefined;
}>;

/**
 * Delete up to `limit` of the `outbox_deliveries` rows in a final state
 * (`Delivered`, `Failed`, `Skipped`, a fan-out row's `Expanded`) last updated before
 * `updatedBefore`; a `Queued` row, or a state this build does not know, is
 * kept. Resolves to how many rows went.
 */
export type PruneTerminalDeliveries = (
  updatedBefore: string,
  limit: number,
) => Promise<Result<number, RepositoryError>>;

/**
 * Delete up to `limit` of the `outbound_activities` created before
 * `createdBefore` that no read still needs: none of its delivery rows is
 * unfinished, and it is not among the newest `keepPerAccount` public
 * `Create` / `Announce` of its account (what the ActivityPub outbox lists).
 */
export type PruneOutboundActivities = (
  createdBefore: string,
  keepPerAccount: number,
  limit: number,
) => Promise<Result<number, RepositoryError>>;

/**
 * Delete up to `limit` of the handled `inbox_activities` received before
 * `receivedBefore`; an open claim stays.
 */
export type PruneInboxActivities = (
  receivedBefore: string,
  limit: number,
) => Promise<Result<number, RepositoryError>>;

/** What one vacuum pass deleted per table, and whether a full batch asks for another pass. */
export type ActivityVacuumPass = Readonly<{
  deliveries: number;
  outbound: number;
  inbox: number;
  chained: boolean;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows per table per pass; a full batch in any table chains another pass. */
const BATCH = 500;

/**
 * The defaults, in days. Mastodon stores no deliveries (Sidekiq jobs vanish
 * once done) and keeps no inbound activity log, so these only bound growth.
 */
const DEFAULT_DAYS = { deliveries: 30, outbound: 30, inbox: 30 } as const;

/**
 * The shortest inbox retention: `inbox_activities` is the inbox's dedupe by
 * activity id, so a redelivery must still find its row. Mastodon retries a
 * delivery 16 times with Sidekiq's backoff (about 2 to 3 days) and other
 * servers retry for up to about a week; 7 days covers them.
 */
const MIN_INBOX_DAYS = 7;

/**
 * The most items the ActivityPub outbox lists (`queryLimit`'s cap of 40):
 * each account keeps at least that many public `Create` / `Announce`
 * activities whatever their age, so its outbox still renders a full page.
 */
const KEEP_OUTBOX_ITEMS = 40;

const OFF_VALUES = new Set(["0", "off", "false", "no", "none"]);

const parseWindow = (raw: string | undefined, fallback: number, min: number): RetentionWindow => {
  const value = (raw ?? "").trim().toLowerCase();
  if (value.length === 0) {
    return { kind: "Days", days: fallback };
  }
  if (OFF_VALUES.has(value)) {
    return { kind: "Off" };
  }
  if (!/^\d+$/.test(value)) {
    return { kind: "Days", days: fallback };
  }
  return { kind: "Days", days: Math.max(min, Number.parseInt(value, 10)) };
};

const cutoffOf = (window: RetentionWindow, nowMs: number): string | undefined =>
  window.kind === "Off" ? undefined : new Date(nowMs - window.days * DAY_MS).toISOString();

export const RetentionWindow = {
  schema: RetentionWindowSchema,
  /**
   * A retention var: empty or unset is `fallback` days, `0` / `off` is no
   * pruning, a positive whole number is days (no fewer than `min`), anything
   * else is `fallback`.
   */
  parse: parseWindow,
  /** Rows older than this instant (ISO) are past the window; none for `Off`. */
  cutoff: cutoffOf,
};

export const ActivityVacuum = {
  batch: BATCH,
  defaultDays: DEFAULT_DAYS,
  minInboxDays: MIN_INBOX_DAYS,
  keepOutboxItems: KEEP_OUTBOX_ITEMS,

  /**
   * The retention from its vars: empty is the default, `0` / `off` turns a
   * table's pruning off, a positive whole number is days (the inbox no fewer
   * than {@link MIN_INBOX_DAYS}); anything else is the default.
   */
  retention: (vars: ActivityRetentionVars): ActivityRetention => ({
    deliveries: parseWindow(vars.deliveries, DEFAULT_DAYS.deliveries, 1),
    outbound: parseWindow(vars.outbound, DEFAULT_DAYS.outbound, 1),
    inbox: parseWindow(vars.inbox, DEFAULT_DAYS.inbox, MIN_INBOX_DAYS),
  }),

  /** Rows older than this instant (ISO) are past the window; none for `Off`. */
  cutoff: cutoffOf,

  /**
   * One pass: a batch of finished deliveries, then outbound activities
   * (whose check reads the deliveries left), then inbox activities. A table
   * whose pruning is off is not queried.
   */
  pass: async (
    deps: Readonly<{
      pruneDeliveries: PruneTerminalDeliveries;
      pruneOutbound: PruneOutboundActivities;
      pruneInbox: PruneInboxActivities;
    }>,
    retention: ActivityRetention,
    nowMs: number,
  ): Promise<Result<ActivityVacuumPass, RepositoryError>> => {
    const run = async (
      window: RetentionWindow,
      prune: (cutoff: string) => Promise<Result<number, RepositoryError>>,
    ): Promise<Result<number, RepositoryError>> => {
      const cutoff = cutoffOf(window, nowMs);
      return cutoff === undefined ? ok(0) : prune(cutoff);
    };
    const deliveries = await run(retention.deliveries, (cutoff) =>
      deps.pruneDeliveries(cutoff, BATCH),
    );
    if (deliveries.isErr()) {
      return err(deliveries.error);
    }
    const outbound = await run(retention.outbound, (cutoff) =>
      deps.pruneOutbound(cutoff, KEEP_OUTBOX_ITEMS, BATCH),
    );
    if (outbound.isErr()) {
      return err(outbound.error);
    }
    const inbox = await run(retention.inbox, (cutoff) => deps.pruneInbox(cutoff, BATCH));
    if (inbox.isErr()) {
      return err(inbox.error);
    }
    return ok({
      deliveries: deliveries.value,
      outbound: outbound.value,
      inbox: inbox.value,
      chained: [deliveries.value, outbound.value, inbox.value].some((count) => count >= BATCH),
    });
  },
} as const;
