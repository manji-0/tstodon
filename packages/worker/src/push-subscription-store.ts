import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import type { Result } from "neverthrow";
import { runD1, type RepositoryError } from "./d1";
import { nowIso } from "./clock";
import { parseJsonColumn } from "./json-column";
import { queryTyped } from "./typed-sql";
import {
  deletePushSubscription as deletePushSubscriptionSql,
  findTokenPushSubscription as findTokenPushSubscriptionSql,
  listPushSubscriptions as listPushSubscriptionsSql,
  updatePushSubscriptionData as updatePushSubscriptionDataSql,
  upsertPushSubscription as upsertPushSubscriptionSql,
} from "./generated/prisma/sql";

/** Mastodon's `data[alerts][...]` keys, in the order the entity reports them. */
export const PUSH_ALERT_KEYS = [
  "mention",
  "quote",
  "status",
  "reblog",
  "follow",
  "follow_request",
  "favourite",
  "poll",
  "update",
  "quoted_update",
  "admin.sign_up",
  "admin.report",
] as const;

export type PushAlertKey = (typeof PUSH_ALERT_KEYS)[number];

export type PushAlerts = Readonly<Record<PushAlertKey, boolean>>;

export const PushPolicySchema = z.union([
  z.literal("all"),
  z.literal("followed"),
  z.literal("follower"),
  z.literal("none"),
]);

export type PushPolicy = z.infer<typeof PushPolicySchema>;

export type PushSubscription = Readonly<{
  id: number;
  accountId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  standard: boolean;
  alerts: PushAlerts;
  policy: PushPolicy;
}>;

const PushSubscriptionRowSchema = z.object({
  id: z.union([z.number(), z.bigint()]),
  account_id: z.string().min(1),
  endpoint: z.string().min(1),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  standard: z.union([z.number(), z.bigint()]),
  alerts_json: z.string(),
  policy: z.string(),
});

const StoredAlertsSchema = z.record(z.string(), z.boolean());

/** Every alert off, the default for each key the request leaves out. */
export const noAlerts = (): Record<PushAlertKey, boolean> => ({
  mention: false,
  quote: false,
  status: false,
  reblog: false,
  follow: false,
  follow_request: false,
  favourite: false,
  poll: false,
  update: false,
  quoted_update: false,
  "admin.sign_up": false,
  "admin.report": false,
});

const subscriptionFromRow = (raw: unknown): PushSubscription | undefined => {
  const row = schemaResult(PushSubscriptionRowSchema)(raw);
  if (row.isErr()) {
    return undefined;
  }
  const stored = parseJsonColumn(StoredAlertsSchema, row.value.alerts_json);
  const alerts = noAlerts();
  for (const key of PUSH_ALERT_KEYS) {
    alerts[key] = stored.isOk() && stored.value[key] === true;
  }
  const policy = schemaResult(PushPolicySchema)(row.value.policy);
  return {
    id: Number(row.value.id),
    accountId: row.value.account_id,
    endpoint: row.value.endpoint,
    p256dh: row.value.p256dh,
    auth: row.value.auth,
    standard: Number(row.value.standard) === 1,
    alerts,
    policy: policy.isOk() ? policy.value : "all",
  };
};

const subscriptionsFrom = (rows: ReadonlyArray<unknown>): PushSubscription[] =>
  rows.flatMap((raw) => {
    const subscription = subscriptionFromRow(raw);
    return subscription ? [subscription] : [];
  });

/**
 * Subscribe the access token: a token holds one subscription, and a new one
 * replaces it (with a new id), as Mastodon's `POST` does.
 */
export const upsertPushSubscription = async (
  db: D1Database,
  input: Readonly<{
    accessTokenId: string;
    accountId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    standard: boolean;
    alerts: PushAlerts;
    policy: PushPolicy;
  }>,
): Promise<Result<PushSubscription | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(
      db,
      upsertPushSubscriptionSql(
        input.accessTokenId,
        input.accountId,
        input.endpoint,
        input.p256dh,
        input.auth,
        input.standard ? 1 : 0,
        JSON.stringify(input.alerts),
        input.policy,
        nowIso(),
      ),
    );
    return subscriptionsFrom(rows)[0];
  });

/** The access token's subscription. */
export const findTokenPushSubscription = async (
  db: D1Database,
  accessTokenId: string,
): Promise<Result<PushSubscription | undefined, RepositoryError>> =>
  runD1(
    async () =>
      subscriptionsFrom(await queryTyped(db, findTokenPushSubscriptionSql(accessTokenId)))[0],
  );

export const listPushSubscriptions = async (
  db: D1Database,
  accountId: string,
): Promise<Result<PushSubscription[], RepositoryError>> =>
  runD1(async () => subscriptionsFrom(await queryTyped(db, listPushSubscriptionsSql(accountId))));

export const updatePushSubscriptionData = async (
  db: D1Database,
  accessTokenId: string,
  alerts: PushAlerts,
  policy: PushPolicy,
): Promise<Result<PushSubscription | undefined, RepositoryError>> =>
  runD1(
    async () =>
      subscriptionsFrom(
        await queryTyped(
          db,
          updatePushSubscriptionDataSql(accessTokenId, JSON.stringify(alerts), policy, nowIso()),
        ),
      )[0],
  );

export const deletePushSubscription = async (
  db: D1Database,
  id: number,
): Promise<Result<boolean, RepositoryError>> =>
  runD1(async () => (await queryTyped(db, deletePushSubscriptionSql(id))).length > 0);
