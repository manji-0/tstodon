import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { openStream } from "../test/stream-fixture";

const ORIGIN = "https://example.com";

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  return { status: response.status, body: await response.json() };
};

const idOf = (body: unknown): string => {
  const parsed = schemaResult(z.object({ id: z.string() }))(body);
  if (parsed.isErr()) {
    throw new Error("response without an id");
  }
  return parsed.value.id;
};

const post = async (email: string, status: string): Promise<string> => {
  const posted = await json(email, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  expect(posted.status).toBe(200);
  return idOf(posted.body);
};

const follow = async (email: string, targetEmail: string) => {
  const target = await signedInAccount(targetEmail);
  const followed = await json(email, `/api/v1/accounts/${target.id}/follow`, {
    method: "POST",
    body: "{}",
  });
  expect(followed.status).toBe(200);
};

const createList = async (email: string, title: string): Promise<string> => {
  const created = await json(email, "/api/v1/lists", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  expect(created.status).toBe(200);
  return idOf(created.body);
};

describe("streaming subscriptions", () => {
  it("tag each event with the stream it was subscribed on; user:notification hears only notifications", async () => {
    const target = "st-notify-target@example.com";
    const all = await openStream({ email: target, query: "?stream=user" });
    const notifications = await openStream({ email: target, query: "?stream=user:notification" });

    await follow("st-notify-follower@example.com", target);
    const onUser = await all.next();
    expect(onUser).toMatchObject({ stream: ["user"], event: "notification" });
    expect(await notifications.next()).toMatchObject({
      stream: ["user:notification"],
      event: "notification",
      payload: onUser.payload,
    });

    const own = await post(target, "not a notification");
    expect(await all.next()).toMatchObject({ stream: ["user"], event: "update" });
    expect(own.length).toBeGreaterThan(0);
    expect(await notifications.heardNothing({ kind: "UserNotification" })).toBe(true);
    all.close();
    notifications.close();
  });

  it("start with no stream until one is subscribed, and stop on unsubscribe", async () => {
    const email = "st-subscribe@example.com";
    const socket = await openStream({ email });
    await post(email, "before subscribing");
    await socket.subscribe({ stream: "user" });
    expect(await socket.heardNothing()).toBe(true);

    const id = await post(email, "after subscribing");
    expect(await socket.next()).toMatchObject({ stream: ["user"], event: "update" });
    expect(id.length).toBeGreaterThan(0);

    const barrier = await socket.unsubscribe({ stream: "user" });
    await post(email, "after unsubscribing");
    expect(await socket.heardNothing(barrier)).toBe(true);
    socket.close();
  });

  it("let only the list's owner subscribe to it", async () => {
    const owner = "st-list-owner@example.com";
    const listId = await createList(owner, "mine");
    const ownerSocket = await openStream({ email: owner });
    await ownerSocket.subscribe({ stream: "list", list: listId });

    const other = await openStream({ email: "st-list-other@example.com" });
    other.send({ type: "subscribe", stream: "list", list: listId });
    expect(await other.nextError()).toEqual({
      error: "Not authorized to stream this list",
      status: 401,
    });
    const upgrade = await SELF.fetch(`${ORIGIN}/api/v1/streaming?stream=list&list=${listId}`, {
      headers: { ...(await authHeaders("st-list-other@example.com")), Upgrade: "websocket" },
    });
    expect(upgrade.status).toBe(401);
    ownerSocket.close();
    other.close();
  });

  it("keep anonymous sockets to public and hashtag streams", async () => {
    const anonymous = await openStream({ query: "?stream=public:local" });
    anonymous.send({ type: "subscribe", stream: "user" });
    expect(await anonymous.nextError()).toEqual({ error: "Missing access token", status: 401 });
    anonymous.send({ type: "subscribe", stream: "hashtag" });
    expect(await anonymous.nextError()).toEqual({
      error: "Missing tag name parameter",
      status: 400,
    });
    anonymous.send({ type: "subscribe", stream: "everything" });
    expect(await anonymous.nextError()).toEqual({ error: "Unknown stream type", status: 400 });
    await anonymous.subscribe({ stream: "hashtag", tag: "cats" });
    const refused = await SELF.fetch(`${ORIGIN}/api/v1/streaming?stream=user`, {
      headers: { Upgrade: "websocket" },
    });
    expect(refused.status).toBe(401);
    anonymous.close();
  });
});
