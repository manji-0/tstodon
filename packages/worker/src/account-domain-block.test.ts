import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { Hostname, OutboxJob } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { blockAccountDomain, SEVER_PAGE_SIZE } from "./account-domain-block";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
import { parseInstanceIdentity } from "./runtime-config";

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

  it("severs a domain larger than one page through queued follow-up pages", async () => {
    const a = "dblock-sever-paged@example.com";
    const account = await signedInAccount(a);
    const total = SEVER_PAGE_SIZE + 2;
    const fans = await Promise.all(
      Array.from({ length: total }, (_, index) => remoteActor(`fan${index}`, "dblock-paged.test")),
    );
    await env.DB.batch(
      fans.map((fan, index) =>
        env.DB.prepare(
          `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, follow_activity_id, remote_request_kind, follow_kind, created_at)
           VALUES (?, ?, ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
        ).bind(`dblock-paged-${index}`, fan.actorUri, account.id, `${fan.actorUri}/follows/1`),
      ),
    );
    expect(await counts(a)).toEqual({ followers_count: total, following_count: 0 });

    const sent: OutboxJob[] = [];
    const queueEnv = new Proxy(env, {
      get: (target, key) =>
        key === "OUTBOX_PROCESS_QUEUE"
          ? {
              send: async (message: unknown) => {
                const job = OutboxJob.parse(message);
                if (job.isOk()) {
                  sent.push(job.value);
                }
              },
            }
          : Reflect.get(target, key),
    });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect(
      (
        await blockAccountDomain(
          queueEnv,
          identity,
          account,
          Hostname.ofAuthority("dblock-paged.test"),
        )
      ).isOk(),
    ).toBe(true);
    expect(sent).toHaveLength(1);
    expect((await counts(a)).followers_count).toBeGreaterThan(0);
    expect(await severedEvents(a)).toEqual([]);

    for (let job = sent.shift(); job !== undefined; job = sent.shift()) {
      expect(await processOutboxJob(queueEnv, job)).toBe("ok");
    }

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
});
