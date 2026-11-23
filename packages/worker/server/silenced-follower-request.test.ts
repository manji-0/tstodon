import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";

const ORIGIN = "https://example.com";

const followKind = async (accountId: string, actorUri: string) =>
  parseRows(
    z.object({ follow_kind: z.string() }),
    (
      await env.DB.prepare(
        "SELECT follow_kind FROM remote_follows WHERE target_account_id = ? AND remote_actor_uri = ?",
      )
        .bind(accountId, actorUri)
        .all()
    ).results,
  )[0]?.follow_kind;

const queuedAccepts = async (accountId: string) =>
  (
    await env.DB.prepare(
      "SELECT count(*) AS n FROM outbound_activities WHERE account_id = ? AND kind = 'Accept'",
    )
      .bind(accountId)
      .first()
  )?.["n"];

const listed = async (email: string, path: string) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, { headers: await authHeaders(email) });
  expect(response.status).toBe(200);
  return z.array(z.unknown()).parse(await response.json());
};

/** The types of the account's notifications, and the URIs of its follow requests. */
const requestsAndNotifications = async (email: string) => ({
  requests: z
    .array(z.object({ uri: z.string() }))
    .parse(await listed(email, "/api/v1/follow_requests"))
    .map((account) => account.uri),
  notifications: z
    .array(z.object({ type: z.string() }))
    .parse(await listed(email, "/api/v1/notifications"))
    .map((notification) => notification.type),
});

const sendFollow = async (remote: Remote, username: string, n = 1): Promise<void> => {
  expect(
    await remote.send({
      id: `${remote.actorUri}/follows/${n}`,
      type: "Follow",
      object: `${ORIGIN}/users/${username}`,
    }),
  ).toBe(202);
};

/**
 * Mastodon's `ActivityPub::Activity::Follow` holds the follow of a silenced
 * account as a request, even of an unlocked account
 * (`target_account.locked? || @account.silenced?`), whoever silenced it.
 */
describe("a Follow from a silenced remote actor", () => {
  it("waits for approval when an admin silenced the actor", async () => {
    const email = "silenced-follow-own@example.com";
    const account = await signedInAccount(email);
    const follower = await remoteActor("silenced-own", "silenced-own.example");
    await env.DB.prepare(
      "INSERT INTO remote_actor_moderation (actor_uri, moderation) VALUES (?, 'Silenced')",
    )
      .bind(follower.actorUri)
      .run();

    await sendFollow(follower, account.username);

    expect(await followKind(account.id, follower.actorUri)).toBe("None");
    expect(await queuedAccepts(account.id)).toBe(0);
    // The request's notification is filtered as any from a silenced sender
    // the account does not follow (`filtered_by_limited_accounts_policy?`).
    expect(await requestsAndNotifications(email)).toEqual({
      requests: [follower.actorUri],
      notifications: [],
    });
  });

  it("waits for approval when a domain block silences the actor's domain", async () => {
    const email = "silenced-follow-domain@example.com";
    const account = await signedInAccount(email);
    const follower = await remoteActor("silenced-domain", "silenced-domain.example");
    const blocked = await SELF.fetch(`${ORIGIN}/api/v1/admin/domain_blocks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("silenced-follow-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({ domain: "silenced-domain.example", severity: "silence" }),
    });
    expect(blocked.status).toBe(200);

    await sendFollow(follower, account.username);

    expect(await followKind(account.id, follower.actorUri)).toBe("None");
    expect(await queuedAccepts(account.id)).toBe(0);
    // The request's notification is filtered as any from a silenced sender
    // the account does not follow (`filtered_by_limited_accounts_policy?`).
    expect(await requestsAndNotifications(email)).toEqual({
      requests: [follower.actorUri],
      notifications: [],
    });
  });

  it("is accepted at once when nothing silences the actor", async () => {
    const email = "silenced-follow-none@example.com";
    const account = await signedInAccount(email);
    const follower = await remoteActor("not-silenced", "not-silenced.example");

    await sendFollow(follower, account.username);

    expect(await followKind(account.id, follower.actorUri)).toBe("Accepted");
    expect(await queuedAccepts(account.id)).toBe(1);
    expect(await requestsAndNotifications(email)).toEqual({
      requests: [],
      notifications: ["follow"],
    });
  });

  it("keeps a follow it holds when the silenced actor sends the Follow again", async () => {
    const account = await signedInAccount("silenced-follow-again@example.com");
    const follower = await remoteActor("silenced-again", "silenced-again.example");
    await sendFollow(follower, account.username);
    await env.DB.prepare(
      "INSERT INTO remote_actor_moderation (actor_uri, moderation) VALUES (?, 'Silenced')",
    )
      .bind(follower.actorUri)
      .run();

    // Mastodon's `existing_follow` fast-forward: accepted again.
    await sendFollow(follower, account.username, 2);

    expect(await followKind(account.id, follower.actorUri)).toBe("Accepted");
    expect(await queuedAccepts(account.id)).toBe(2);
  });
});
