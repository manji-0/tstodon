import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { Hostname, type LocalAccount, OutboxJob } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { blockAccountDomain, SEVER_PAGE_SIZE } from "./account-domain-block";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
import { parseInstanceIdentity } from "./runtime-config";

// The paged-severance cases took up to 11 s on a lightly loaded machine, past
// the shared 15 s budget once several suites share the CPU (#50).
vi.setConfig({ testTimeout: 45_000 });

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const send = async (email: string, path: string, method = "POST", body?: unknown) =>
  json(path, {
    method,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = async (email: string, path: string) =>
  json(path, { headers: await authHeaders(email) });

const remoteId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const Counts = z.object({ followers_count: z.number(), following_count: z.number() });
const counts = async (email: string) =>
  read(Counts, (await get(email, "/api/v1/accounts/verify_credentials")).body);

const lock = async (email: string): Promise<void> => {
  const account = await signedInAccount(email);
  await env.DB.prepare("UPDATE accounts SET locked = 1 WHERE id = ?").bind(account.id).run();
};

/** The activities of `kind` the account queued, with the inbox each goes to. */
const queued = async (email: string, kind: string) => {
  const account = await signedInAccount(email);
  const rows = await env.DB.prepare(
    `SELECT a.payload_json, d.inbox_url FROM outbound_activities a
     JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NOT NULL
     WHERE a.account_id = ? AND a.kind = ? ORDER BY a.rowid`,
  )
    .bind(account.id, kind)
    .all<{ payload_json: string; inbox_url: string }>();
  return rows.results.map((row) => ({
    inbox: row.inbox_url,
    activity: read(
      z.object({ id: z.string(), type: z.string(), actor: z.string(), object: z.unknown() }),
      JSON.parse(row.payload_json),
    ),
  }));
};

/** `email` follows `remote`, and with `accepted` the remote answers with an `Accept`. */
const follow = async (email: string, remote: Remote, accepted = true): Promise<string> => {
  expect(
    (await send(email, `/api/v1/accounts/${remoteId(remote)}/follow`, "POST", {})).status,
  ).toBe(200);
  const account = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(account.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  const followId = row?.follow_activity_id ?? "";
  if (accepted) {
    expect(
      await remote.send({ id: `${remote.actorUri}/accepts/1`, type: "Accept", object: followId }),
    ).toBe(202);
  }
  return followId;
};

/** `remote` sends `email` a `Follow`. */
const followedBy = async (remote: Remote, email: string): Promise<string> => {
  const account = await signedInAccount(email);
  const followId = `${remote.actorUri}/follows/1`;
  expect(
    await remote.send({
      id: followId,
      type: "Follow",
      object: `https://example.com/users/${account.username}`,
    }),
  ).toBe(202);
  return followId;
};

const EventSchema = z.object({
  type: z.string(),
  target_name: z.string(),
  followers_count: z.number(),
  following_count: z.number(),
});

const severedEvents = async (email: string) =>
  read(
    z.array(z.object({ type: z.literal("severed_relationships"), event: EventSchema })),
    (await get(email, "/api/v1/notifications?types[]=severed_relationships")).body,
  ).map((notification) => notification.event);

const blockDomain = async (email: string, domain: string) =>
  expect((await send(email, "/api/v1/domain_blocks", "POST", { domain })).status).toBe(200);

type Faults = Readonly<{
  /** Where queued jobs go. */
  sent: OutboxJob[];
  /** Statements whose SQL matches fail when they run. */
  failSql?: RegExp;
  /** Queueing a job throws. */
  failQueue?: boolean;
}>;

/** `env` with its outbox queue captured and, optionally, some D1 statements or the queue failing. */
const faultyEnv = ({ sent, failSql, failQueue = false }: Faults): Env => {
  const db = new Proxy(env.DB, {
    get: (target, key) => {
      if (key === "prepare") {
        return (sql: string) =>
          target.prepare(failSql?.test(sql) ? "SELECT * FROM fault_injected_table" : sql);
      }
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const queue = {
    send: async (message: unknown) => {
      if (failQueue) {
        throw new Error("queue unavailable");
      }
      const job = OutboxJob.parse(message);
      if (job.isOk()) {
        sent.push(job.value);
      }
    },
  };
  return new Proxy(env, {
    get: (target, key) =>
      key === "DB" ? db : key === "OUTBOX_PROCESS_QUEUE" ? queue : Reflect.get(target, key),
  });
};

/** `count` accepted followers of `account` on `domain`, written directly. */
const seedFollowers = async (accountId: string, domain: string, count: number) => {
  const fans = await Promise.all(
    Array.from({ length: count }, (_, index) => remoteActor(`fan${index}`, domain)),
  );
  await env.DB.batch(
    fans.map((fan, index) =>
      env.DB.prepare(
        `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, follow_activity_id, remote_request_kind, follow_kind, created_at)
         VALUES (?, ?, ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
      ).bind(`${domain}-${index}`, fan.actorUri, accountId, `${fan.actorUri}/follows/1`),
    ),
  );
  return fans;
};

const blockAs = (target: Env, account: LocalAccount, domain: string) =>
  blockAccountDomain(
    target,
    parseInstanceIdentity(env)._unsafeUnwrap(),
    account,
    Hostname.ofAuthority(domain),
  );

/** Follows of the account that are both still live and already recorded as severed. */
const recordedButLive = async (accountId: string) =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM severed_relationships s
       WHERE s.local_account_id = ?
         AND (s.id IN (SELECT id FROM remote_follows) OR s.id IN (SELECT id FROM outbound_follows))`,
    )
      .bind(accountId)
      .first<{ n: number }>()
  )?.n;

const drain = async (target: Env, sent: OutboxJob[]) => {
  const outcomes: string[] = [];
  for (let job = sent.shift(); job !== undefined; job = sent.shift()) {
    outcomes.push(await processOutboxJob(target, job));
  }
  return outcomes;
};

describe("blocking a domain severs the account's follows with it", () => {
  it("drops the follows both ways, federates Undo and Reject, and records the event", async () => {
    const a = "dblock-sever-a@example.com";
    const followed = await remoteActor("followed", "dblock-sever.test");
    const follower = await remoteActor("follower", "dblock-sever.test");
    const elsewhere = await remoteActor("elsewhere", "dblock-kept.test");
    const followId = await follow(a, followed);
    const remoteFollowId = await followedBy(follower, a);
    await follow(a, elsewhere);
    await followedBy(elsewhere, a);
    expect(await counts(a)).toEqual({ followers_count: 2, following_count: 2 });

    await blockDomain(a, "dblock-sever.test");

    expect(await counts(a)).toEqual({ followers_count: 1, following_count: 1 });
    const actor = `https://example.com/users/${(await signedInAccount(a)).username}`;
    expect(await queued(a, "Undo")).toMatchObject([
      {
        inbox: `${followed.actorUri}/inbox`,
        activity: { type: "Undo", actor, object: { id: followId, type: "Follow" } },
      },
    ]);
    expect(await queued(a, "Reject")).toMatchObject([
      {
        inbox: `${follower.actorUri}/inbox`,
        activity: {
          type: "Reject",
          actor,
          object: { id: remoteFollowId, type: "Follow", actor: follower.actorUri },
        },
      },
    ]);
    expect(await severedEvents(a)).toEqual([
      {
        type: "user_domain_block",
        target_name: "dblock-sever.test",
        followers_count: 1,
        following_count: 1,
      },
    ]);
  });

  it("rejects pending requests from the domain without recording them", async () => {
    const a = "dblock-sever-locked@example.com";
    await lock(a);
    const requester = await remoteActor("requester", "dblock-pending.test");
    const requestId = await followedBy(requester, a);
    expect((await get(a, "/api/v1/follow_requests")).body).toHaveLength(1);

    await blockDomain(a, "dblock-pending.test");

    expect((await get(a, "/api/v1/follow_requests")).body).toEqual([]);
    expect(await queued(a, "Reject")).toMatchObject([
      { activity: { type: "Reject", object: { id: requestId, type: "Follow" } } },
    ]);
    expect(await severedEvents(a)).toEqual([]);
  });

  it("withdraws the account's pending requests to the domain, so a later Accept follows no one", async () => {
    const a = "dblock-sever-requested@example.com";
    const requested = await remoteActor("requested", "dblock-requested.test");
    const followId = await follow(a, requested, false);
    const relationship = async () =>
      read(
        z.array(z.object({ following: z.boolean(), requested: z.boolean() })),
        (await get(a, `/api/v1/accounts/relationships?id[]=${remoteId(requested)}`)).body,
      )[0];
    expect(await relationship()).toMatchObject({ following: false, requested: true });

    await blockDomain(a, "dblock-requested.test");

    expect(await relationship()).toMatchObject({ following: false, requested: false });
    expect(await queued(a, "Undo")).toMatchObject([
      { activity: { type: "Undo", object: { id: followId, type: "Follow" } } },
    ]);
    expect(
      await requested.send({
        id: `${requested.actorUri}/accepts/1`,
        type: "Accept",
        object: followId,
      }),
    ).toBe(202);
    expect(await relationship()).toMatchObject({ following: false, requested: false });
    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });
    expect(await severedEvents(a)).toEqual([]);
  });

  it("clears the account's notifications from the domain and the senders it accepted there", async () => {
    const a = "dblock-notifications@example.com";
    const post = async (text: string) =>
      read(
        z.object({ uri: z.string() }),
        (await send(a, "/api/v1/statuses", "POST", { status: text })).body,
      ).uri;
    const status = await post("seen from afar");
    const like = (remote: Remote, slug: string, object = status) =>
      remote.send({ id: `${remote.actorUri}/likes/${slug}`, type: "Like", object });
    const senders = async () =>
      read(
        z.array(z.object({ account: z.object({ id: z.string() }) })),
        (await get(a, "/api/v1/notifications")).body,
      ).map((notification) => notification.account.id);
    const requests = async () =>
      read(
        z.array(z.object({ id: z.string() })),
        (await get(a, "/api/v1/notifications/requests")).body,
      );
    const stranger = await remoteActor("stranger", "dblock-notified.test");
    const accepted = await remoteActor("accepted", "dblock-notified.test");
    const elsewhere = await remoteActor("elsewhere", "dblock-unnotified.test");
    expect(await like(stranger, "1")).toBe(202);
    expect(await like(elsewhere, "1")).toBe(202);
    expect(
      (await send(a, "/api/v2/notifications/policy", "PATCH", { for_not_following: "filter" }))
        .status,
    ).toBe(200);
    expect(await like(accepted, "1")).toBe(202);
    const held = await requests();
    expect(held).toHaveLength(1);
    expect(
      (await send(a, `/api/v1/notifications/requests/${held[0]?.id ?? ""}/accept`)).status,
    ).toBe(200);
    expect((await senders()).sort()).toEqual(
      [remoteId(stranger), remoteId(accepted), remoteId(elsewhere)].sort(),
    );

    await blockDomain(a, "dblock-notified.test");

    expect(await senders()).toEqual([remoteId(elsewhere)]);
    expect(
      (await send(a, "/api/v1/domain_blocks?domain=dblock-notified.test", "DELETE")).status,
    ).toBe(200);
    expect(await senders()).toEqual([remoteId(elsewhere)]);
    expect(await like(accepted, "2", await post("seen again"))).toBe(202);
    expect(await senders()).toEqual([remoteId(elsewhere)]);
    expect(await requests()).toHaveLength(1);
  });

  it("clears notifications from more of the domain's senders than one page holds", async () => {
    const a = "dblock-notifications-paged@example.com";
    const account = await signedInAccount(a);
    const total = SEVER_PAGE_SIZE + 2;
    const senders = await Promise.all(
      Array.from({ length: total }, (_, index) =>
        remoteActor(`sender${index}`, "dblock-noisy.test"),
      ),
    );
    await env.DB.batch(
      senders.map((sender, index) =>
        env.DB.prepare(
          `INSERT INTO notifications (id, account_id, from_account_id, from_actor_uri, kind, created_at)
           VALUES (?, ?, ?, ?, 'mention', '2026-10-21T00:00:00.000Z')`,
        ).bind(`dblock-noisy-${index}`, account.id, remoteId(sender), sender.actorUri),
      ),
    );
    const listed = async () => {
      const body = (await get(a, "/api/v1/notifications?limit=80")).body;
      return read(z.array(z.unknown()), body).length;
    };
    expect(await listed()).toBe(total);
    const sent: OutboxJob[] = [];
    const queueEnv = faultyEnv({ sent });

    await blockAs(queueEnv, account, "dblock-noisy.test");
    expect(await listed()).toBeGreaterThan(0);
    await drain(queueEnv, sent);

    expect(await listed()).toBe(0);
  });

  it("severs a domain larger than one page through queued follow-up pages", async () => {
    const a = "dblock-sever-paged@example.com";
    const account = await signedInAccount(a);
    const total = SEVER_PAGE_SIZE + 2;
    await seedFollowers(account.id, "dblock-paged.test", total);
    expect(await counts(a)).toEqual({ followers_count: total, following_count: 0 });

    const sent: OutboxJob[] = [];
    const queueEnv = faultyEnv({ sent });
    expect((await blockAs(queueEnv, account, "dblock-paged.test")).isOk()).toBe(true);
    expect(sent).toHaveLength(1);
    expect((await counts(a)).followers_count).toBeGreaterThan(0);
    expect(await severedEvents(a)).toEqual([]);

    expect(await drain(queueEnv, sent)).toEqual(["ok"]);

    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });
    expect(await queued(a, "Reject")).toHaveLength(total);
    expect(await severedEvents(a)).toEqual([
      {
        type: "user_domain_block",
        target_name: "dblock-paged.test",
        followers_count: total,
        following_count: 0,
      },
    ]);
  });

  it("restores nothing when the domain is unblocked", async () => {
    const a = "dblock-sever-unblock@example.com";
    const followed = await remoteActor("unblocked", "dblock-unblock.test");
    await follow(a, followed);
    await blockDomain(a, "dblock-unblock.test");
    expect(
      (await send(a, "/api/v1/domain_blocks?domain=dblock-unblock.test", "DELETE")).status,
    ).toBe(200);
    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });
  });

  it("never records a follow it failed to remove, and severs it on the retry", async () => {
    const a = "dblock-sever-faulty@example.com";
    const account = await signedInAccount(a);
    await seedFollowers(account.id, "dblock-faulty.test", 2);
    const sent: OutboxJob[] = [];

    const blocked = await blockAs(
      faultyEnv({ sent, failSql: /^\s*DELETE FROM remote_follows/ }),
      account,
      "dblock-faulty.test",
    );

    expect(blocked.isOk()).toBe(true);
    expect(await recordedButLive(account.id)).toBe(0);
    expect(sent).toHaveLength(1);
    expect(await drain(faultyEnv({ sent }), sent)).toEqual(["ok"]);
    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });
    expect(await severedEvents(a)).toEqual([
      {
        type: "user_domain_block",
        target_name: "dblock-faulty.test",
        followers_count: 2,
        following_count: 0,
      },
    ]);
  });

  it("retries a page whose follow-up page could not be queued", async () => {
    const a = "dblock-sever-requeue@example.com";
    const account = await signedInAccount(a);
    await seedFollowers(account.id, "dblock-requeue.test", SEVER_PAGE_SIZE * 2 + 1);
    const sent: OutboxJob[] = [];
    await blockAs(faultyEnv({ sent }), account, "dblock-requeue.test");
    expect(sent).toHaveLength(1);

    expect(await drain(faultyEnv({ sent, failQueue: true }), sent)).toEqual(["retry"]);
  });

  it("notifies the account on the retry when the notification failed", async () => {
    const a = "dblock-sever-notify@example.com";
    const account = await signedInAccount(a);
    await seedFollowers(account.id, "dblock-notify.test", 1);
    const sent: OutboxJob[] = [];

    await blockAs(
      faultyEnv({ sent, failSql: /^\s*INSERT INTO notifications/ }),
      account,
      "dblock-notify.test",
    );
    expect(await severedEvents(a)).toEqual([]);
    expect(await drain(faultyEnv({ sent }), sent)).toEqual(["ok"]);

    expect(await severedEvents(a)).toEqual([
      {
        type: "user_domain_block",
        target_name: "dblock-notify.test",
        followers_count: 1,
        following_count: 0,
      },
    ]);
  });

  it("stops severing when the domain is unblocked before a queued page runs", async () => {
    const a = "dblock-sever-stop@example.com";
    const account = await signedInAccount(a);
    await seedFollowers(account.id, "dblock-stop.test", SEVER_PAGE_SIZE + 2);
    const sent: OutboxJob[] = [];
    await blockAs(faultyEnv({ sent }), account, "dblock-stop.test");
    expect((await send(a, "/api/v1/domain_blocks?domain=dblock-stop.test", "DELETE")).status).toBe(
      200,
    );

    expect(await drain(faultyEnv({ sent }), sent)).toEqual(["ok"]);

    expect(await counts(a)).toEqual({ followers_count: 2, following_count: 0 });
    expect(await severedEvents(a)).toEqual([
      {
        type: "user_domain_block",
        target_name: "dblock-stop.test",
        followers_count: SEVER_PAGE_SIZE,
        following_count: 0,
      },
    ]);
  });

  it("keeps one event when the domain is blocked again while a severance runs", async () => {
    const a = "dblock-sever-twice@example.com";
    const account = await signedInAccount(a);
    await seedFollowers(account.id, "dblock-twice.test", SEVER_PAGE_SIZE + 2);
    const sent: OutboxJob[] = [];
    const target = faultyEnv({ sent });

    await blockAs(target, account, "dblock-twice.test");
    await blockAs(target, account, "dblock-twice.test");
    await drain(target, sent);

    expect(await counts(a)).toEqual({ followers_count: 0, following_count: 0 });
    expect(await severedEvents(a)).toEqual([
      {
        type: "user_domain_block",
        target_name: "dblock-twice.test",
        followers_count: SEVER_PAGE_SIZE + 2,
        following_count: 0,
      },
    ]);
  });
});
