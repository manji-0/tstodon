import { warmSchemas } from "@tstodon/core";
import {
  DeliveryDomainHealth,
  type DeliveryDomainChange,
  type DeliveryDomainHealthDeps,
  type DeliveryDomainHealthValue,
  type DeliveryReachability,
  Hostname,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { type RepositoryError, runD1, toRepositoryError } from "./d1";
import {
  deleteDeliveryDomainHealth as deleteDeliveryDomainHealthSql,
  findDeliveryDomainHealth as findDeliveryDomainHealthSql,
  listDeliveryDomainHealth as listDeliveryDomainHealthSql,
  listUnavailableDeliveryDomains as listUnavailableDeliveryDomainsSql,
  upsertDeliveryDomainHealth as upsertDeliveryDomainHealthSql,
} from "./generated/prisma/sql";
import { writeMetric } from "./metrics";
import { queryTyped, runTyped } from "./typed-sql";

const HealthRowSchema = z.object({
  domain: z.string().min(1),
  kind: z.string(),
  failure_days: z.number(),
  last_failure_day: z.string(),
  unavailable_since: z.string().nullable(),
});

type HealthRow = z.infer<typeof HealthRowSchema>;

const fromRow = (row: HealthRow): Result<DeliveryDomainHealthValue, RepositoryError> =>
  DeliveryDomainHealth.parse({
    kind: row.kind,
    domain: row.domain,
    failureDays: row.failure_days,
    lastFailureDay: row.last_failure_day,
    ...(row.kind === "Unavailable" ? { unavailableSince: row.unavailable_since } : {}),
  }).mapErr(() => toRepositoryError("invalid delivery domain health row"));

/** Rows the isolate cache and the admin list read at most. */
const LIST_LIMIT = 10_000;

export const listDeliveryDomainHealth = async (
  db: D1Database,
): Promise<Result<DeliveryDomainHealthValue[], RepositoryError>> => {
  const rows = await runD1(() =>
    queryTyped(db, listDeliveryDomainHealthSql(LIST_LIMIT), HealthRowSchema),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  // A row that does not parse is left out, as `queryTyped` leaves out rows.
  return ok(
    rows.value.flatMap((row) =>
      fromRow(row).match(
        (health) => [health],
        () => [],
      ),
    ),
  );
};

export const findDeliveryDomainHealth = async (
  db: D1Database,
  domain: Hostname,
): Promise<Result<DeliveryDomainHealthValue | undefined, RepositoryError>> => {
  const rows = await runD1(() =>
    queryTyped(db, findDeliveryDomainHealthSql(domain), HealthRowSchema),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const row = rows.value[0];
  return row === undefined ? ok(undefined) : fromRow(row);
};

const saveDeliveryDomainHealth = async (
  db: D1Database,
  health: DeliveryDomainHealthValue,
): Promise<Result<void, RepositoryError>> => {
  const saved = await runD1(() =>
    runTyped(
      db,
      upsertDeliveryDomainHealthSql(
        health.domain,
        health.kind,
        health.failureDays,
        health.lastFailureDay,
        health.kind === "Unavailable" ? health.unavailableSince : null,
        nowIso(),
      ),
    ),
  );
  cache.entries?.set(health.domain, health);
  return saved.map(() => undefined);
};

/** Forget the domain's failures: it is available again. */
export const clearDeliveryDomainHealth = async (
  db: D1Database,
  domain: Hostname,
): Promise<Result<void, RepositoryError>> => {
  const cleared = await runD1(() => runTyped(db, deleteDeliveryDomainHealthSql(domain)));
  cache.entries?.delete(domain);
  return cleared.map(() => undefined);
};

/**
 * This isolate's copy of `delivery_domain_health`, read again after a minute.
 * The table holds only domains that are failing, so it stays small; the copy
 * spares a D1 read on every delivery attempt and every inbound activity, at
 * the cost of up to a minute before another isolate's change is seen there
 * (an attempt may go to a domain just marked unavailable; an inbound activity
 * may not clear a domain marked failing within the minute).
 */
const CACHE_TTL_MS = 60_000;

const cache: {
  loadedAt: number;
  entries: Map<string, DeliveryDomainHealthValue> | undefined;
} = { loadedAt: 0, entries: undefined };

/** Drop the isolate copy (tests, and after an admin change). */
export const forgetDeliveryDomainHealthCache = (): void => {
  cache.entries = undefined;
  cache.loadedAt = 0;
};

const cachedEntries = async (
  db: D1Database,
): Promise<ReadonlyMap<string, DeliveryDomainHealthValue>> => {
  const now = Date.now();
  if (cache.entries !== undefined && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.entries;
  }
  const listed = await listDeliveryDomainHealth(db);
  if (listed.isErr()) {
    // Fail open: a delivery is attempted rather than skipped, and the next
    // call reads again.
    return cache.entries ?? new Map();
  }
  cache.entries = new Map(listed.value.map((health) => [health.domain, health]));
  cache.loadedAt = now;
  return cache.entries;
};

export const cachedDeliveryDomainHealth = async (
  db: D1Database,
  domain: Hostname,
): Promise<DeliveryDomainHealthValue | undefined> => (await cachedEntries(db)).get(domain);

const DomainRowSchema = z.object({ domain: z.string().min(1) });

/**
 * The domains deliveries are skipped for, read from D1: once per activity at
 * fan-out or enqueue, so a domain marked or cleared anywhere counts at once.
 * Fails open (no domain skipped) when D1 cannot answer.
 */
export const unavailableDeliveryDomains = async (db: D1Database): Promise<ReadonlySet<string>> => {
  const rows = await runD1(() =>
    queryTyped(db, listUnavailableDeliveryDomainsSql(), DomainRowSchema),
  );
  return new Set((rows.isOk() ? rows.value : []).map((row) => Hostname.ofAuthority(row.domain)));
};

export const deliveryDomainHealthDeps = (db: D1Database): DeliveryDomainHealthDeps => ({
  cached: (domain) => cachedDeliveryDomainHealth(db, domain),
  find: (domain) => findDeliveryDomainHealth(db, domain),
  save: (health) => saveDeliveryDomainHealth(db, health),
  clear: (domain) => clearDeliveryDomainHealth(db, domain),
});

/** Where the news about a domain came from, for the log line. */
export type DeliveryDomainEvidence = "delivery" | "inbound" | "admin";

/** Log (and count) a domain becoming unavailable or available again. */
export const logDeliveryDomainChange = (
  env: Env,
  domain: Hostname,
  change: DeliveryDomainChange,
  via: DeliveryDomainEvidence,
): void => {
  switch (change.kind) {
    case "BecameUnavailable":
      console.warn(
        JSON.stringify({
          kind: "DeliveryDomainUnavailable",
          domain,
          failureDays: change.failureDays,
        }),
      );
      writeMetric(env, "outbox.domain", [change.failureDays], ["unavailable", via]);
      return;
    case "Cleared":
      if (change.wasUnavailable) {
        console.log(
          JSON.stringify({
            kind: "DeliveryDomainAvailable",
            domain,
            failureDays: change.failureDays,
            via,
          }),
        );
        writeMetric(env, "outbox.domain", [change.failureDays], ["available", via]);
      }
      return;
    case "FailureDayRecorded":
    case "Unchanged":
      return;
  }
};

/**
 * Record what a delivery attempt or an inbound activity says about `host`
 * and log a change. Best effort: a D1 error is logged and swallowed, so it
 * never fails the delivery or the inbox request it rides on.
 */
export const recordDeliveryReachability = async (
  env: Env,
  host: Hostname,
  reachability: DeliveryReachability,
  via: DeliveryDomainEvidence,
  nowMs: number = Date.now(),
): Promise<DeliveryDomainChange> => {
  const recorded = await DeliveryDomainHealth.record(
    deliveryDomainHealthDeps(env.DB),
    host,
    reachability,
    nowMs,
  );
  if (recorded.isErr()) {
    console.error(
      JSON.stringify({
        kind: "DeliveryDomainHealthNotRecorded",
        domain: host,
        reachability,
        message: recorded.error.message,
      }),
    );
    return { kind: "Unchanged" };
  }
  logDeliveryDomainChange(env, host, recorded.value, via);
  return recorded.value;
};

/** {@link recordDeliveryReachability} for a URI's host; nothing when it has none. */
export const recordInboxReachability = async (
  env: Env,
  inboxUrl: string,
  reachability: DeliveryReachability,
  nowMs?: number,
): Promise<DeliveryDomainChange> => {
  const host = Hostname.ofUri(inboxUrl);
  return host === undefined
    ? { kind: "Unchanged" }
    : recordDeliveryReachability(env, host, reachability, "delivery", nowMs);
};

warmSchemas([HealthRowSchema, DomainRowSchema]);
