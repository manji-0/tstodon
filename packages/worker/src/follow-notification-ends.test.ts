import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

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

const send = async (email: string, path: string, body: unknown = {}) => {
  const response = await json(path, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, `POST ${path}`).toBe(200);
};

const Notifications = z.array(
  z.object({ type: z.string(), account: z.object({ id: z.string() }) }),
);

/** The follow notifications the account sees, as `type` and sender id. */
const followNotifications = async (email: string): Promise<string[]> =>
  read(
    Notifications,
    (await json("/api/v1/notifications", { headers: await authHeaders(email) })).body,
  )
    .filter((entry) => entry.type === "follow" || entry.type === "follow_request")
    .map((entry) => `${entry.type} ${entry.account.id}`);

const lock = async (email: string): Promise<void> => {
  const account = await signedInAccount(email);
  await env.DB.prepare("UPDATE accounts SET locked = 1 WHERE id = ?").bind(account.id).run();
};

const remoteId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const remoteFollows = async (remote: Remote, email: string, n = 1): Promise<string> => {
  const account = await signedInAccount(email);
  const followId = `${remote.actorUri}/follows/${n}`;
  expect(
    await remote.send({
      id: followId,
      type: "Follow",
      object: `https://example.com/users/${account.username}`,
    }),
  ).toBe(202);
  return followId;
};

const pair = async (prefix: string) => {
  const a = `${prefix}-a@example.com`;
  const b = `${prefix}-b@example.com`;
  return { a, b, aId: (await signedInAccount(a)).id, bId: (await signedInAccount(b)).id };
};

describe("a local follow's notification ends with the follow", () => {
  it("goes when the follower unfollows, and a new follow notifies afresh", async () => {
    const { a, b, aId, bId } = await pair("follow-notif-unfollow");
    await send(a, `/api/v1/accounts/${bId}/follow`);
    expect(await followNotifications(b)).toEqual([`follow ${aId}`]);

    await send(a, `/api/v1/accounts/${bId}/unfollow`);
    expect(await followNotifications(b)).toEqual([]);

    await send(a, `/api/v1/accounts/${bId}/follow`);
    expect(await followNotifications(b)).toEqual([`follow ${aId}`]);
  });

  it("goes when the requester withdraws the request", async () => {
    const { a, b, aId, bId } = await pair("follow-notif-withdraw");
    await lock(b);
    await send(a, `/api/v1/accounts/${bId}/follow`);
    expect(await followNotifications(b)).toEqual([`follow_request ${aId}`]);

    await send(a, `/api/v1/accounts/${bId}/unfollow`);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("goes when the target rejects the request", async () => {
    const { a, b, aId, bId } = await pair("follow-notif-reject");
    await lock(b);
    await send(a, `/api/v1/accounts/${bId}/follow`);
    await send(b, `/api/v1/follow_requests/${aId}/reject`);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("goes when the target authorizes the request, and no follow notification replaces it", async () => {
    const { a, b, aId, bId } = await pair("follow-notif-authorize");
    await lock(b);
    await send(a, `/api/v1/accounts/${bId}/follow`);
    await send(b, `/api/v1/follow_requests/${aId}/authorize`);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("goes when the target removes the follower", async () => {
    const { a, b, aId, bId } = await pair("follow-notif-remove");
    await send(a, `/api/v1/accounts/${bId}/follow`);
    await send(b, `/api/v1/accounts/${aId}/remove_from_followers`);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("goes when either side blocks the other", async () => {
    const { a, b, aId, bId } = await pair("follow-notif-block");
    await send(a, `/api/v1/accounts/${bId}/follow`);
    await send(b, `/api/v1/accounts/${aId}/follow`);
    await send(a, `/api/v1/accounts/${bId}/block`);
    await send(a, `/api/v1/accounts/${bId}/unblock`);
    expect(await followNotifications(a)).toEqual([]);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("leaves another follower's notification in place", async () => {
    const { a, b, bId } = await pair("follow-notif-other");
    const c = "follow-notif-other-c@example.com";
    const cId = (await signedInAccount(c)).id;
    await send(a, `/api/v1/accounts/${bId}/follow`);
    await send(c, `/api/v1/accounts/${bId}/follow`);
    await send(a, `/api/v1/accounts/${bId}/unfollow`);
    expect(await followNotifications(b)).toEqual([`follow ${cId}`]);
  });

  it("leaves the notification requests once a held follow notification goes", async () => {
    const { a, b, bId } = await pair("follow-notif-held");
    const patched = await json("/api/v2/notifications/policy", {
      method: "PATCH",
      headers: { ...(await authHeaders(b)), "content-type": "application/json" },
      body: JSON.stringify({ for_not_following: "filter" }),
    });
    expect(patched.status).toBe(200);
    await send(a, `/api/v1/accounts/${bId}/follow`);
    const requests = async () =>
      read(
        z.array(z.unknown()),
        (await json("/api/v1/notifications/requests", { headers: await authHeaders(b) })).body,
      );
    expect(await requests()).toHaveLength(1);

    await send(a, `/api/v1/accounts/${bId}/unfollow`);
    expect(await requests()).toEqual([]);
  });
});

describe("a remote follow's notification ends with the follow", () => {
  it("goes on Undo(Follow), and a new Follow notifies afresh", async () => {
    const b = "remote-follow-notif-undo@example.com";
    const remote = await remoteActor("follow-notif-undoer");
    const followId = await remoteFollows(remote, b);
    expect(await followNotifications(b)).toEqual([`follow ${remoteId(remote)}`]);

    const username = (await signedInAccount(b)).username;
    expect(
      await remote.send({
        id: `${remote.actorUri}#undo/1`,
        type: "Undo",
        object: {
          id: followId,
          type: "Follow",
          actor: remote.actorUri,
          object: `https://example.com/users/${username}`,
        },
      }),
    ).toBe(202);
    expect(await followNotifications(b)).toEqual([]);

    await remoteFollows(remote, b, 2);
    expect(await followNotifications(b)).toEqual([`follow ${remoteId(remote)}`]);
  });

  it("goes when the target rejects the request", async () => {
    const b = "remote-follow-notif-reject@example.com";
    await lock(b);
    const remote = await remoteActor("follow-notif-rejected");
    await remoteFollows(remote, b);
    expect(await followNotifications(b)).toEqual([`follow_request ${remoteId(remote)}`]);

    await send(b, `/api/v1/follow_requests/${remoteId(remote)}/reject`);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("goes when the target authorizes the request", async () => {
    const b = "remote-follow-notif-authorize@example.com";
    await lock(b);
    const remote = await remoteActor("follow-notif-authorized");
    await remoteFollows(remote, b);
    await send(b, `/api/v1/follow_requests/${remoteId(remote)}/authorize`);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("goes when the target removes the follower", async () => {
    const b = "remote-follow-notif-remove@example.com";
    const remote = await remoteActor("follow-notif-removed");
    await remoteFollows(remote, b);
    await send(b, `/api/v1/accounts/${remoteId(remote)}/remove_from_followers`);
    expect(await followNotifications(b)).toEqual([]);
  });

  it("goes when the target blocks the follower and unblocks again", async () => {
    const b = "remote-follow-notif-block@example.com";
    const remote = await remoteActor("follow-notif-blocked");
    await remoteFollows(remote, b);
    await send(b, `/api/v1/accounts/${remoteId(remote)}/block`);
    await send(b, `/api/v1/accounts/${remoteId(remote)}/unblock`);
    expect(await followNotifications(b)).toEqual([]);
  });
});
