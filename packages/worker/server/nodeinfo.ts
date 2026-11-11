import type { NodeInfo20JSON, NodeInfo21JSON } from "@tstodon/api/activitypub";
import type { Context } from "hono";
import { Result } from "neverthrow";
import { type InstanceIdentity } from "@tstodon/domain";
import { countActiveAccounts } from "./account-activity";
import { countAccounts } from "./account-store";
import type { RepositoryError } from "./d1";
import { jsonRepositoryError } from "./http";
import { parseInstanceIdentity, registrationsOpen } from "./runtime-config";
import { countStatuses } from "./status-store";

/** Mastodon's `active_users` windows: signed in within 30 and 180 days. */
export const ACTIVE_MONTH_DAYS = 30;
export const ACTIVE_HALFYEAR_DAYS = 180;

/** Nodeinfo counts every local status, so each document is cached this long. */
const CACHE_SECONDS = 300;
const CACHE_CONTROL = `public, max-age=${CACHE_SECONDS}, stale-while-revalidate=1500`;

type NodeinfoVersion = "2.0" | "2.1";

const nodeinfoDocument = async (
  env: Env,
  identity: InstanceIdentity,
  version: NodeinfoVersion,
): Promise<Result<NodeInfo20JSON | NodeInfo21JSON, RepositoryError>> => {
  const counts = Result.combine([
    ...(await Promise.all([
      countAccounts(env.DB),
      countActiveAccounts(env.DB, ACTIVE_MONTH_DAYS),
      countActiveAccounts(env.DB, ACTIVE_HALFYEAR_DAYS),
      countStatuses(env.DB),
    ])),
  ]);
  return counts.map(([total, activeMonth, activeHalfyear, localPosts]) => {
    const shared = {
      protocols: ["activitypub" as const],
      services: { inbound: [], outbound: [] },
      // As the REST instance's `registrations.enabled` (Mastodon's
      // `registrations_mode != 'none'`).
      openRegistrations: registrationsOpen(env),
      usage: { users: { total, activeMonth, activeHalfyear }, localPosts },
      metadata: { nodeName: identity.name, nodeDescription: identity.description },
    };
    const software = { name: "tstodon", version: "0.1.0" };
    return version === "2.0"
      ? { version, software, ...shared }
      : {
          version,
          software: { ...software, repository: identity.sourceUrl, homepage: identity.sourceUrl },
          ...shared,
        };
  });
};

/**
 * `/nodeinfo/2.0` and `/nodeinfo/2.1`, through the edge cache for 300 s (the
 * counts scan the account and activity tables). "Active" follows Mastodon's
 * `active_users`: a local account that made an authenticated request (token
 * or browser session) within the window, from `account_activity_days`.
 */
export const serveNodeinfo = async (c: Context<{ Bindings: Env }>, version: NodeinfoVersion) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const cache = caches.default;
  const cacheKey = new Request(
    `${identity.value.publicOrigin.replace(/\/$/, "")}/nodeinfo/${version}`,
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }
  const document = await nodeinfoDocument(c.env, identity.value, version);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  const response = c.json(document.value, 200, { "Cache-Control": CACHE_CONTROL });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
};
