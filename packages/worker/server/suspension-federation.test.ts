import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { ActivityId, type OutboxJob } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { meter, patchD1, resetMeter } from "../test/meter";
import { drainJobs, queueCapturingEnv } from "../test/queue-capture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { moderateRemoteActor } from "./admin-actions";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
import { SUSPENDED_ACTOR_PAGE_SIZE } from "./suspended-actor-severance";

vi.setConfig({ testTimeout: 60_000 });

const ORIGIN = "https://example.com";
const ADMIN = "suspension-admin@example.com";
/** Half of D1's 1,000 statements per invocation: a page must leave room for the rest. */
const PAGE_STATEMENT_BUDGET = 500;

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const admin = async (path: string, body?: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(ADMIN, { admin: true })) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, path).toBe(200);
  await response.text();
};

const ActorUpdateSchema = z.object({
  id: z.string(),
  type: z.literal("Update"),
  object: z.object({ name: z.string(), suspended: z.boolean().optional() }),
});

/** The actor `Update`s the account queued, oldest first, with their outbox rows' ids. */
const actorUpdates = async (accountId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid",
  )
    .bind(accountId)
    .all<{ id: string; payload_json: string }>();
  return results.map((row) => ({
    rowId: row.id,
    object: read(ActorUpdateSchema, JSON.parse(row.payload_json)).object,
  }));
};

const FollowActivitySchema = z.object({
  type: z.string(),
  actor: z.string(),
  object: z.object({ id: z.string(), type: z.literal("Follow") }),
});

/** The activities of `kind` the account queued, with the inbox each goes to. */
const queued = async (accountId: string, kind: "Reject" | "Undo") => {
  const { results } = await env.DB.prepare(
    `SELECT a.payload_json, d.inbox_url FROM outbound_activities a
     JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NOT NULL
     WHERE a.account_id = ? AND a.kind = ? ORDER BY a.rowid`,
  )
    .bind(accountId, kind)
    .all<{ payload_json: string; inbox_url: string }>();
  return results.map((row) => ({
    inbox: row.inbox_url,
    follow: read(FollowActivitySchema, JSON.parse(row.payload_json)).object.id,
  }));
};

const deliveryInboxes = async (activityRowId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
  )
    .bind(activityRowId)
    .all<{ inbox_url: string }>();
  return results.map((row) => row.inbox_url);
};

/** `remote` follows the account, accepted, by the `Follow` with id `followId`. */
const followedBy = async (remote: Remote, accountId: string, followId: string | null) =>
  env.DB.prepare(
    `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, follow_activity_id, remote_request_kind, follow_kind, created_at)
     VALUES (?, ?, ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
  )
    .bind(crypto.randomUUID(), remote.actorUri, accountId, followId)
    .run();

/** The account follows `remote`, accepted, since `createdAt`. */
const follows = async (accountId: string, remote: Remote, followId: string, createdAt: string) =>
  env.DB.prepare(
    `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state, created_at)
     VALUES (?, ?, ?, ?, 'Accepted', ?)`,
  )
    .bind(crypto.randomUUID(), accountId, remote.actorUri, followId, createdAt)
    .run();

describe("suspending a local account", () => {
  it("sends its actor Update with `suspended`, and without it once lifted", async () => {
    const account = await signedInAccount("suspend-local@example.com");

    await admin(`/api/v1/admin/accounts/${account.id}/action`, { type: "suspend" });
    const actor = await SELF.fetch(`${ORIGIN}/users/${account.username}`, {
      headers: { Accept: "application/activity+json" },
    });
    expect(await actor.json()).toMatchObject({ suspended: true });
    await admin(`/api/v1/admin/accounts/${account.id}/unsuspend`);

    expect((await actorUpdates(account.id)).map((update) => update.object)).toEqual([
      { name: account.username, suspended: true },
      { name: account.displayName },
    ]);
  });

  it("reaches the inboxes that know the account, as Mastodon's AccountReachFinder", async () => {
    const account = await signedInAccount("suspend-reach@example.com");
    const follower = await remoteActor("follower", "reach-follower.example");
    const followed = await remoteActor("followed", "reach-followed.example");
    const longFollowed = await remoteActor("long", "reach-long.example");
    const mentioned = await remoteActor("mentioned", "reach-mentioned.example");
    const reporter = await remoteActor("reporter", "reach-reporter.example");
    await followedBy(follower, account.id, `${follower.actorUri}/follows/1`);
    await follows(account.id, followed, `${ORIGIN}/follows/reach-1`, new Date().toISOString());
    await follows(
      account.id,
      longFollowed,
      `${ORIGIN}/follows/reach-2`,
      "2020-01-01T00:00:00.000Z",
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO statuses (id, account_id, kind, content_text, content_html, visibility, sensitive, spoiler_text, created_at, updated_at)
         VALUES ('reach-status', ?, 'LocalNote', 'hi', '<p>hi</p>', 'public', 0, '', ?, ?)`,
      ).bind(account.id, new Date().toISOString(), new Date().toISOString()),
      env.DB.prepare(
        "INSERT INTO status_remote_mentions (status_id, actor_uri) VALUES ('reach-status', ?)",
      ).bind(mentioned.actorUri),
      env.DB.prepare(
        "INSERT INTO reports (id, reporter_actor_uri, target_account_id) VALUES ('reach-report', ?, ?)",
      ).bind(reporter.actorUri, account.id),
    ]);

    await admin(`/api/v1/admin/accounts/${account.id}/action`, { type: "suspend" });
    const [update] = await actorUpdates(account.id);
    const activityId = ActivityId.parse(update?.rowId ?? "")._unsafeUnwrap();
    expect(await processOutboxJob(env, { kind: "ExpandFollowers", activityId })).toBe("ok");

    expect(await deliveryInboxes(activityId)).toEqual(
      [follower, followed, mentioned, reporter].map((remote) => `${remote.actorUri}/inbox`).sort(),
    );
  });
});

describe("suspending a remote actor", () => {
  it("sends a Reject(Follow) for each of its follows and an Undo(Follow) for each follow of it", async () => {
    const a = await signedInAccount("suspend-remote-a@example.com");
    const b = await signedInAccount("suspend-remote-b@example.com");
    const suspended = await remoteActor("suspended", "suspend-remote.example");
    await followedBy(suspended, a.id, `${suspended.actorUri}/follows/a`);
    await followedBy(suspended, b.id, null);
    await follows(a.id, suspended, `${ORIGIN}/follows/suspend-a`, "2026-10-21T00:00:00.000Z");

    await admin(`/api/v1/admin/accounts/${RemoteAccountId.encode(suspended.actorUri)}/action`, {
      type: "suspend",
    });

    const inbox = `${suspended.actorUri}/inbox`;
    expect(await queued(a.id, "Reject")).toEqual([
      { inbox, follow: `${suspended.actorUri}/follows/a` },
    ]);
    expect(await queued(b.id, "Reject")).toEqual([{ inbox, follow: suspended.actorUri }]);
    expect(await queued(a.id, "Undo")).toEqual([{ inbox, follow: `${ORIGIN}/follows/suspend-a` }]);
    expect(await queued(b.id, "Undo")).toEqual([]);
  });

  it("severs more local accounts than a page holds in queued pages, each within its budget", async () => {
    const total = SUSPENDED_ACTOR_PAGE_SIZE * 2 + 1;
    const suspended = await remoteActor("popular", "suspend-many.example");
    const accounts = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        signedInAccount(`suspend-many-${index}@example.com`),
      ),
    );
    // Follows both ways, the costliest page: a notification, a Reject and an Undo per account.
    for (const account of accounts) {
      await followedBy(suspended, account.id, `${suspended.actorUri}/follows/${account.id}`);
      await follows(
        account.id,
        suspended,
        `${ORIGIN}/follows/many-${account.id}`,
        "2026-10-21T00:00:00.000Z",
      );
    }
    const sent: OutboxJob[] = [];
    const target = queueCapturingEnv(sent);
    patchD1();
    const statements: number[] = [];
    const metered = async <T>(run: () => Promise<T>): Promise<T> => {
      resetMeter();
      const result = await run();
      statements.push(meter.tally.statements);
      return result;
    };

    const moderated = await metered(() =>
      moderateRemoteActor(target, suspended.actorUri, "suspend"),
    );
    expect(moderated.isOk()).toBe(true);
    const outcomes = await drainJobs(target, sent, "SeverSuspendedActorFollows", metered);

    expect(outcomes).toEqual(["ok", "ok"]);
    expect(statements).toHaveLength(3);
    for (const count of statements) {
      expect(count).toBeLessThan(PAGE_STATEMENT_BUDGET);
    }
    for (const account of accounts) {
      expect(await queued(account.id, "Reject")).toHaveLength(1);
      expect(await queued(account.id, "Undo")).toHaveLength(1);
    }
    const left = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM remote_follows WHERE remote_actor_uri = ?1)
            + (SELECT COUNT(*) FROM outbound_follows WHERE actor_uri = ?1) AS n`,
    )
      .bind(suspended.actorUri)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
