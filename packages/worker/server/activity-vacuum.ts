import {
  ActivityVacuum,
  type ActivityRetention,
  type ActivityVacuumPass,
  type RetentionWindow,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { type RepositoryError, runD1 } from "./d1";
import { elapsedMs, writeMetric } from "./metrics";
import { optionalEnvString } from "./runtime-config";
import { runTyped } from "./typed-sql";
import {
  pruneInboxActivities as pruneInboxActivitiesSql,
  pruneOutboundActivities as pruneOutboundActivitiesSql,
  pruneTerminalDeliveries as pruneTerminalDeliveriesSql,
} from "./generated/prisma/sql";

/**
 * `OUTBOX_DELIVERY_RETENTION_DAYS`, `OUTBOUND_ACTIVITY_RETENTION_DAYS` and
 * `INBOX_ACTIVITY_RETENTION_DAYS` (see "Activity retention" in
 * docs/reference/configuration.md).
 */
export const activityRetention = (env: Env): ActivityRetention =>
  ActivityVacuum.retention({
    deliveries: optionalEnvString(env, "OUTBOX_DELIVERY_RETENTION_DAYS"),
    outbound: optionalEnvString(env, "OUTBOUND_ACTIVITY_RETENTION_DAYS"),
    inbox: optionalEnvString(env, "INBOX_ACTIVITY_RETENTION_DAYS"),
  });

const changes = (result: D1Result): number => result.meta.changes ?? 0;

export const pruneTerminalDeliveries = (
  db: D1Database,
  updatedBefore: string,
  limit: number,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => changes(await runTyped(db, pruneTerminalDeliveriesSql(updatedBefore, limit))));

export const pruneOutboundActivities = (
  db: D1Database,
  createdBefore: string,
  keepPerAccount: number,
  limit: number,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () =>
    changes(await runTyped(db, pruneOutboundActivitiesSql(createdBefore, keepPerAccount, limit))),
  );

export const pruneInboxActivities = (
  db: D1Database,
  receivedBefore: string,
  limit: number,
): Promise<Result<number, RepositoryError>> =>
  runD1(async () => changes(await runTyped(db, pruneInboxActivitiesSql(receivedBefore, limit))));

const windowDays = (window: RetentionWindow): number | "off" =>
  window.kind === "Off" ? "off" : window.days;

/**
 * One pass of the activity vacuum (`VacuumActivities`): a batch per table
 * past its retention. Logs `ActivityVacuumPass` with the counts and writes
 * the `activity.vacuum` metric, whether or not anything went.
 */
export const vacuumActivities = async (
  env: Env,
  nowMs: number = Date.now(),
): Promise<Result<ActivityVacuumPass, RepositoryError>> => {
  const startedAt = Date.now();
  const retention = activityRetention(env);
  const pass = await ActivityVacuum.pass(
    {
      pruneDeliveries: (before, limit) => pruneTerminalDeliveries(env.DB, before, limit),
      pruneOutbound: (before, keep, limit) => pruneOutboundActivities(env.DB, before, keep, limit),
      pruneInbox: (before, limit) => pruneInboxActivities(env.DB, before, limit),
    },
    retention,
    nowMs,
  );
  const ms = elapsedMs(startedAt);
  if (pass.isErr()) {
    console.error(JSON.stringify({ kind: "ActivityVacuumFailed", message: pass.error.message }));
    writeMetric(env, "activity.vacuum", [0, 0, 0, ms], ["error", ""]);
    return pass;
  }
  const { deliveries, outbound, inbox, chained } = pass.value;
  console.log(
    JSON.stringify({
      kind: "ActivityVacuumPass",
      deliveries,
      outbound,
      inbox,
      chained,
      retentionDays: {
        deliveries: windowDays(retention.deliveries),
        outbound: windowDays(retention.outbound),
        inbox: windowDays(retention.inbox),
      },
      ms,
    }),
  );
  // doubles: [deliveries, outbound, inbox, ms]; blobs: [ok | error, chained | ""]
  writeMetric(
    env,
    "activity.vacuum",
    [deliveries, outbound, inbox, ms],
    ["ok", chained ? "chained" : ""],
  );
  return pass;
};
