import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { STREAM_TAG_MAX_LENGTH } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { openStream } from "../test/stream-fixture";
import { MAX_HUB_TAGGED_CHANNELS, MAX_SOCKET_CHANNELS } from "./stream-hub";

const ORIGIN = "https://example.com";

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
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

const rows = async (hub: string): Promise<number> =>
  (
    await env.DB.prepare("SELECT COUNT(*) AS n FROM stream_subscriptions WHERE hub = ?")
      .bind(hub)
      .first<{ n: number }>()
  )?.n ?? 0;

const eventually = async (hub: string, expected: number): Promise<void> => {
  for (let attempt = 0; attempt < 100 && (await rows(hub)) !== expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(await rows(hub)).toBe(expected);
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

  it("carry a list member's posts to the list's stream, and not a non-member's", async () => {
    const owner = "st-listed-owner@example.com";
    const member = "st-listed-member@example.com";
    const outsider = "st-listed-outsider@example.com";
    await follow(owner, member);
    await follow(owner, outsider);
    const listId = await createList(owner, "friends");
    const added = await json(owner, `/api/v1/lists/${listId}/accounts`, {
      method: "POST",
      body: JSON.stringify({ account_ids: [(await signedInAccount(member)).id] }),
    });
    expect(added.status).toBe(200);
    const socket = await openStream({ email: owner });
    await socket.subscribe({ stream: "list", list: listId });

    await post(outsider, "not on the list");
    const id = await post(member, "on the list");
    const heard = await socket.next();
    expect(heard).toMatchObject({ stream: ["list", listId], event: "update" });
    expect(idOf(JSON.parse(heard.payload))).toBe(id);
    expect(await socket.heardNothing({ kind: "List", listId })).toBe(true);

    const deleted = await json(member, `/api/v1/statuses/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await socket.next()).toEqual({ stream: ["list", listId], event: "delete", payload: id });
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

  it("refuse hashtag names that are not hashtags, on connect and on subscribe", async () => {
    for (const tag of ["_", "%25", "a".repeat(STREAM_TAG_MAX_LENGTH + 1)]) {
      const upgrade = await SELF.fetch(`${ORIGIN}/api/v1/streaming?stream=hashtag&tag=${tag}`, {
        headers: { Upgrade: "websocket" },
      });
      expect(upgrade.status).toBe(400);
      expect(await upgrade.json()).toEqual({ error: "Invalid tag name parameter", status: 400 });
    }
    const socket = await openStream({ email: "st-bad-tag@example.com" });
    socket.send({ type: "subscribe", stream: "hashtag", tag: "_" });
    expect(await socket.nextError()).toEqual({ error: "Invalid tag name parameter", status: 400 });
    expect(await rows(socket.account?.id ?? "")).toBe(0);
    socket.close();
  });

  it("hold the longest hashtags up to the per-socket and per-hub caps, and refuse past them", async () => {
    const email = "st-caps@example.com";
    const tagAt = (index: number): string =>
      `${"日".repeat(STREAM_TAG_MAX_LENGTH - 2)}${String(index).padStart(2, "0")}`;
    expect(MAX_SOCKET_CHANNELS).toBe(MAX_HUB_TAGGED_CHANNELS);
    const full = await openStream({ email });
    const hub = full.account?.id ?? "";
    for (let index = 0; index < MAX_SOCKET_CHANNELS; index += 1) {
      await full.subscribe({ stream: "hashtag", tag: tagAt(index) });
    }
    expect(await rows(hub)).toBe(MAX_SOCKET_CHANNELS);
    expect(
      await full.heardNothing({ kind: "Hashtag", tag: tagAt(0).toLowerCase(), localOnly: false }),
    ).toBe(true);

    full.send({ type: "subscribe", stream: "hashtag", tag: tagAt(MAX_SOCKET_CHANNELS) });
    expect(await full.nextError()).toEqual({
      error: "Too many streams on this connection",
      status: 429,
    });
    expect(await rows(hub)).toBe(MAX_SOCKET_CHANNELS);

    const second = await openStream({ email });
    second.send({ type: "subscribe", stream: "hashtag", tag: tagAt(MAX_SOCKET_CHANNELS) });
    expect(await second.nextError()).toEqual({
      error: "Too many distinct streams open for this viewer",
      status: 429,
    });
    expect(await rows(hub)).toBe(MAX_HUB_TAGGED_CHANNELS);
    await second.subscribe({ stream: "hashtag", tag: tagAt(0) });
    await second.subscribe({ stream: "public" });
    expect(await rows(hub)).toBe(MAX_HUB_TAGGED_CHANNELS + 1);

    full.close();
    second.close();
    await eventually(hub, 0);
  });

  it("leave no row behind for a socket closed while its subscribe is pending", async () => {
    const socket = await openStream({ email: "st-close-pending@example.com" });
    const hub = socket.account?.id ?? "";
    socket.send({ type: "subscribe", stream: "hashtag", tag: "closedearly" });
    socket.send({ type: "subscribe", stream: "public" });
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await eventually(hub, 0);
  });
});
