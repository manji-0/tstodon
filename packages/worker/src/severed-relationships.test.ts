import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor, authHeaders } from "../test/auth-fixture";
import { ORIGIN, read, signUp } from "../test/passkey-browser";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const json = (path: string, init: RequestInit = {}) => SELF.fetch(`${ORIGIN}${path}`, init);

const ADMIN = "severed-admin@example.com";

const adminCall = async (path: string, method: string, body: unknown) =>
  json(path, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(ADMIN, { admin: true })) },
    body: JSON.stringify(body),
  });

const BlockSchema = z.object({ id: z.string() });

const blockDomain = async (domain: string, severity: "silence" | "suspend") => {
  const response = await adminCall("/api/v1/admin/domain_blocks", "POST", { domain, severity });
  expect(response.status).toBe(200);
  return read(BlockSchema, await response.json()).id;
};

/** A signed-in browser, its API credentials, and its account id. */
const person = async (username: string) => {
  const { fetcher } = await signUp(username);
  const lookup = await json(`/api/v1/accounts/lookup?acct=${username}`);
  const { id } = read(z.object({ id: z.string() }), await lookup.json());
  return { fetcher, id, username, token: await accessTokenFor(id) };
};

type Person = Awaited<ReturnType<typeof person>>;

const api = (who: Person, path: string, init: Omit<RequestInit, "headers"> = {}) =>
  json(path, {
    ...init,
    headers: { "content-type": "application/json", Authorization: `Bearer ${who.token}` },
  });

/** `who` follows `remote`; with `accepted`, the remote answers with an `Accept`. */
const follow = async (who: Person, remote: Remote, accepted: boolean) => {
  const response = await api(
    who,
    `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    {
      method: "POST",
      body: JSON.stringify({ reblogs: true, notify: false, languages: ["en", "ja"] }),
    },
  );
  expect(response.status).toBe(200);
  if (!accepted) {
    return;
  }
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(who.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${who.id}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

/** `remote` follows `who`, accepted. */
const followedBy = async (who: Person, remote: Remote) => {
  await env.DB.prepare(
    `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
     VALUES (?, ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
  )
    .bind(`sev-${crypto.randomUUID()}`, remote.actorUri, who.id)
    .run();
};

const count = async (table: "outbound_follows" | "remote_follows", actorUri: string) =>
  (
    await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "outbound_follows" ? "actor_uri" : "remote_actor_uri"} = ?`,
    )
      .bind(actorUri)
      .first<{ n: number }>()
  )?.n;

const EventSchema = z.object({
  id: z.string(),
  type: z.string(),
  purged: z.boolean(),
  target_name: z.string(),
  followers_count: z.number(),
  following_count: z.number(),
  created_at: z.string(),
});

const SeveredNotificationsSchema = z.array(
  z.object({
    id: z.string(),
    type: z.literal("severed_relationships"),
    account: z.object({ id: z.string() }),
    event: EventSchema,
  }),
);

const severedNotifications = async (who: Person) => {
  const response = await api(who, "/api/v1/notifications?types[]=severed_relationships");
  expect(response.status).toBe(200);
  return read(SeveredNotificationsSchema, await response.json());
};

const events = async (who: Person): Promise<string> => {
  const response = await who.fetcher("/severed_relationships");
  expect(response.status).toBe(200);
  return response.text();
};

describe("severed relationships", () => {
  it("records the follows a server suspension removes, and tells each account", async () => {
    const alice = await person("sev_alice");
    const bob = await person("sev_bob");
    const gone = await remoteActor("gone", "sev-bad.example");
    const goneFan = await remoteActor("fan", "sev-bad.example");
    const pending = await remoteActor("pending", "sev-bad.example");
    const kept = await remoteActor("kept", "sev-good.example");
    const keptFan = await remoteActor("keptfan", "sev-good.example");
    await follow(alice, gone, true);
    await follow(alice, pending, false);
    await follow(alice, kept, true);
    await followedBy(alice, goneFan);
    await followedBy(alice, keptFan);

    await blockDomain("sev-bad.example", "suspend");

    expect(await count("outbound_follows", gone.actorUri)).toBe(0);
    expect(await count("outbound_follows", pending.actorUri)).toBe(0);
    expect(await count("remote_follows", goneFan.actorUri)).toBe(0);
    expect(await count("outbound_follows", kept.actorUri)).toBe(1);
    expect(await count("remote_follows", keptFan.actorUri)).toBe(1);

    const [notification, ...others] = await severedNotifications(alice);
    expect(others).toEqual([]);
    expect(notification).toMatchObject({
      account: { id: alice.id },
      event: {
        type: "domain_block",
        purged: false,
        target_name: "sev-bad.example",
        following_count: 1,
        followers_count: 1,
      },
    });
    expect(await severedNotifications(bob)).toEqual([]);

    const grouped = await api(alice, "/api/v2/notifications?types[]=severed_relationships");
    expect(
      read(
        z.object({
          notification_groups: z.array(z.object({ type: z.string(), event: EventSchema })),
        }),
        await grouped.json(),
      ).notification_groups.map((group) => group.event.id),
    ).toEqual([notification?.event.id]);

    const eventId = notification?.event.id ?? "";
    const list = await events(alice);
    expect(list).toContain("Server suspension (sev-bad.example)");
    expect(list).toContain(`href="/severed_relationships/${eventId}/following.csv"`);
    expect(list).toContain(`href="/severed_relationships/${eventId}/followers.csv"`);
    expect(await events(bob)).toContain("No relationships have been severed.");

    const following = await alice.fetcher(`/severed_relationships/${eventId}/following.csv`);
    expect(following.status).toBe(200);
    expect(following.headers.get("content-type")).toContain("text/csv");
    expect(following.headers.get("content-disposition")).toMatch(
      /^attachment; filename="following-sev-bad\.example-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(await following.text()).toBe(
      'Account address,Show boosts,Notify on new posts,Languages\ngone@sev-bad.example,true,false,"en, ja"\n',
    );
    const followers = await alice.fetcher(`/severed_relationships/${eventId}/followers.csv`);
    expect(await followers.text()).toBe("Account address\nfan@sev-bad.example\n");
  });

  it("serves an event's lists only to the account that lost them", async () => {
    const carol = await person("sev_carol");
    const dave = await person("sev_dave");
    const remote = await remoteActor("owned", "sev-owned.example");
    await follow(carol, remote, true);
    await blockDomain("sev-owned.example", "suspend");
    const eventId = (await severedNotifications(carol))[0]?.event.id ?? "";
    expect(eventId).not.toBe("");

    const signedOut = await json(`/severed_relationships/${eventId}/following.csv`, {
      redirect: "manual",
    });
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toContain("/auth/sign_in");
    expect((await json("/severed_relationships", { redirect: "manual" })).status).toBe(302);

    expect((await dave.fetcher(`/severed_relationships/${eventId}/following.csv`)).status).toBe(
      404,
    );
    expect((await dave.fetcher(`/severed_relationships/${eventId}/followers.csv`)).status).toBe(
      404,
    );
    expect((await carol.fetcher(`/severed_relationships/${eventId}/other.csv`)).status).toBe(404);
    expect((await carol.fetcher(`/severed_relationships/0/following.csv`)).status).toBe(404);
    // Nobody followed carol from there, so the followers file is only the header.
    expect(
      await (await carol.fetcher(`/severed_relationships/${eventId}/followers.csv`)).text(),
    ).toBe("Account address\n");
  });

  it("severs a follow of an actor on a non-default port when its hostname is suspended", async () => {
    const erin = await person("sev_erin");
    const remote = await remoteActor("ported", "sev-ported.example:8796");
    await follow(erin, remote, true);
    await blockDomain("sev-ported.example", "suspend");

    expect(await count("outbound_follows", remote.actorUri)).toBe(0);
    const [notification] = await severedNotifications(erin);
    expect(notification?.event).toMatchObject({
      type: "domain_block",
      target_name: "sev-ported.example",
      following_count: 1,
    });
    const following = await erin.fetcher(
      `/severed_relationships/${notification?.event.id ?? ""}/following.csv`,
    );
    expect(await following.text()).toContain("ported@sev-ported.example:8796,");
  });

  it("severs when a silence is raised to a suspension, not before", async () => {
    const erin = await person("sev_erin");
    const remote = await remoteActor("raised", "sev-raised.example");
    await follow(erin, remote, true);
    const blockId = await blockDomain("sev-raised.example", "silence");
    expect(await count("outbound_follows", remote.actorUri)).toBe(1);
    expect(await severedNotifications(erin)).toEqual([]);

    const raised = await adminCall(`/api/v1/admin/domain_blocks/${blockId}`, "PUT", {
      severity: "suspend",
    });
    expect(raised.status).toBe(200);
    expect(await count("outbound_follows", remote.actorUri)).toBe(0);
    expect((await severedNotifications(erin)).map((entry) => entry.event.target_name)).toEqual([
      "sev-raised.example",
    ]);

    // Saving the suspension again has no one left to sever.
    await adminCall(`/api/v1/admin/domain_blocks/${blockId}`, "PUT", { severity: "suspend" });
    expect(await severedNotifications(erin)).toHaveLength(1);
  });

  it("records a suspended remote account as an account suspension", async () => {
    const frank = await person("sev_frank");
    const target = await remoteActor("suspended", "sev-acct.example");
    const bystander = await remoteActor("bystander", "sev-acct.example");
    await follow(frank, target, true);
    await follow(frank, bystander, true);
    await followedBy(frank, target);

    const suspend = () =>
      adminCall(
        `/api/v1/admin/accounts/${RemoteAccountId.encode(target.actorUri)}/action`,
        "POST",
        {
          type: "suspend",
        },
      );
    expect((await suspend()).status).toBe(200);
    expect((await suspend()).status).toBe(200);

    expect(await count("outbound_follows", target.actorUri)).toBe(0);
    expect(await count("remote_follows", target.actorUri)).toBe(0);
    expect(await count("outbound_follows", bystander.actorUri)).toBe(1);
    const found = await severedNotifications(frank);
    expect(found).toHaveLength(1);
    expect(found[0]?.event).toMatchObject({
      type: "account_suspension",
      target_name: "suspended@sev-acct.example",
      following_count: 1,
      followers_count: 1,
    });
    expect(await events(frank)).toContain("Account suspension (suspended@sev-acct.example)");
  });

  it("severs nothing for a silence, a local suspension, or a domain without follows", async () => {
    const gina = await person("sev_gina");
    const remote = await remoteActor("quiet", "sev-quiet.example");
    await follow(gina, remote, true);
    await blockDomain("sev-quiet.example", "silence");
    await blockDomain("sev-nobody.example", "suspend");
    const silenceOnly = await adminCall(
      `/api/v1/admin/accounts/${RemoteAccountId.encode(remote.actorUri)}/action`,
      "POST",
      { type: "silence" },
    );
    expect(silenceOnly.status).toBe(200);
    const localSuspend = await adminCall(`/api/v1/admin/accounts/${gina.id}/action`, "POST", {
      type: "suspend",
    });
    expect(localSuspend.status).toBe(200);

    expect(await count("outbound_follows", remote.actorUri)).toBe(1);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM account_severance_events WHERE account_id = ?",
        )
          .bind(gina.id)
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
});
