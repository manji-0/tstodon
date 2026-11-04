import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { channelOf, openEventStream, requestEventStream } from "../test/sse-fixture";
import { MAX_ACCOUNT_EVENT_STREAMS, MAX_HUB_TAGGED_CHANNELS, SSE_HEARTBEAT_MS } from "./stream-hub";

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

const StatusSchema = z.object({ id: z.string(), content: z.string() });

const statusOf = (data: string) => {
  const parsed = schemaResult(StatusSchema)(JSON.parse(data));
  if (parsed.isErr()) {
    throw new Error("status rejected");
  }
  return parsed.value;
};

/** The next `update` for status `id`; earlier tests' public posts may still be fanning out. */
const updateFor = async (
  stream: Awaited<ReturnType<typeof openEventStream>>,
  id: string,
): Promise<void> => {
  for (;;) {
    const heard = await stream.next();
    if (heard.event === "update" && statusOf(heard.data).id === id) {
      return;
    }
  }
};

describe("streaming over SSE", () => {
  it("answer /health without a token", async () => {
    const health = await SELF.fetch(`${ORIGIN}/api/v1/streaming/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("OK");
  });

  it("send user and user/notification their events as event and data lines", async () => {
    const target = "sse-user-target@example.com";
    const user = await openEventStream("/user", { email: target });
    const notifications = await openEventStream("/user/notification", { email: target });

    await follow("sse-user-follower@example.com", target);
    const onUser = await user.next();
    expect(onUser.event).toBe("notification");
    expect(JSON.parse(onUser.data)).toMatchObject({ type: "follow" });
    expect((await notifications.next()).event).toBe("notification");

    const own = await post(target, "heard on my own user stream");
    const update = await user.next();
    expect(update.event).toBe("update");
    expect(statusOf(update.data).id).toBe(own);
    // user/notification carries nothing but notifications.
    expect(await notifications.heardNothing({ kind: "UserNotification" })).toBe(true);
    await user.cancel();
    await notifications.cancel();
  });

  it("take the token from access_token as well as Authorization", async () => {
    const email = "sse-query-token@example.com";
    const stream = await openEventStream("/user", { email, tokenInQuery: true });
    const id = await post(email, "token in the query");
    expect(statusOf((await stream.next()).data).id).toBe(id);
    await stream.cancel();
  });

  it("serve the public paths by origin, and the media variants", async () => {
    const author = "sse-public-author@example.com";
    const all = await openEventStream("/public");
    const local = await openEventStream("/public/local");
    const remote = await openEventStream("/public/remote");
    const media = await openEventStream("/public/media");

    const id = await post(author, "a public local note");
    await updateFor(all, id);
    await updateFor(local, id);
    expect(await remote.heardNothing(channelOf("public:remote"))).toBe(true);
    expect(await media.heardNothing(channelOf("public:media"))).toBe(true);
    await media.cancel();
    const mediaQuery = await openEventStream("/public?only_media=true");
    await post(author, "still no media");
    expect(await mediaQuery.heardNothing(channelOf("public:media"))).toBe(true);
    for (const stream of [all, local, remote, mediaQuery]) {
      await stream.cancel();
    }
  });

  it("serve hashtag and hashtag/local by tag, and the list and direct streams to their account", async () => {
    const email = "sse-tags-owner@example.com";
    const member = "sse-tags-member@example.com";
    await follow(email, member);
    const tag = await openEventStream("/hashtag?tag=ssecats");
    const localTag = await openEventStream("/hashtag/local?tag=ssecats");
    const listId = idOf(
      (
        await json(email, "/api/v1/lists", {
          method: "POST",
          body: JSON.stringify({ title: "sse" }),
        })
      ).body,
    );
    expect(
      (
        await json(email, `/api/v1/lists/${listId}/accounts`, {
          method: "POST",
          body: JSON.stringify({ account_ids: [(await signedInAccount(member)).id] }),
        })
      ).status,
    ).toBe(200);
    const list = await openEventStream(`/list?list=${listId}`, { email });
    const direct = await openEventStream("/direct", { email });

    const id = await post(member, "love #ssecats");
    for (const stream of [tag, localTag, list]) {
      await updateFor(stream, id);
    }
    expect(await direct.heardNothing({ kind: "Direct" })).toBe(true);

    const recipient = await signedInAccount("sse-direct-recipient@example.com");
    expect(
      (
        await json(email, "/api/v1/statuses", {
          method: "POST",
          body: JSON.stringify({ status: `@${recipient.username} psst`, visibility: "direct" }),
        })
      ).status,
    ).toBe(200);
    expect((await direct.next()).event).toBe("conversation");
    for (const stream of [tag, localTag, list, direct]) {
      await stream.cancel();
    }
  });

  it("refuse streams the token or the path does not allow", async () => {
    const email = "sse-refused@example.com";
    const listId = idOf(
      (
        await json(email, "/api/v1/lists", {
          method: "POST",
          body: JSON.stringify({ title: "refused" }),
        })
      ).body,
    );
    const needsAccount = { error: "Missing access token", status: 401 };
    for (const path of ["/user", "/user/notification", "/direct", `/list?list=${listId}`]) {
      const anonymous = await requestEventStream(path);
      expect(anonymous.status, path).toBe(401);
      expect(await anonymous.json(), path).toEqual(needsAccount);
    }
    const scopes = ["write", "push"];
    for (const path of ["/user", "/user/notification", "/direct", `/list?list=${listId}`]) {
      const refused = await requestEventStream(path, { email, scopes });
      expect(refused.status, path).toBe(401);
      expect(await refused.json(), path).toEqual({
        error: "Access token does not have the required scopes",
        status: 401,
      });
    }
    const other = await requestEventStream(`/list?list=${listId}`, {
      email: "sse-not-the-owner@example.com",
    });
    expect(other.status).toBe(401);
    expect(await other.json()).toEqual({
      error: "Not authorized to stream this list",
      status: 401,
    });

    const badToken = await SELF.fetch(`${ORIGIN}/api/v1/streaming/user`, {
      headers: { Authorization: "Bearer not-a-token" },
    });
    expect(badToken.status).toBe(401);
    expect((await requestEventStream("/hashtag")).status).toBe(400);
    expect((await requestEventStream("/hashtag?tag=%20")).status).toBe(400);
    expect((await requestEventStream("/nonsense")).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/v1/streaming`)).status).toBe(426);

    // Public and hashtag streams need neither a token nor a scope.
    for (const path of ["/public", "/hashtag?tag=open"]) {
      const open = await requestEventStream(path, { email, scopes });
      expect(open.status, path).toBe(200);
      await open.body?.cancel();
    }
  });

  it("send a read:statuses token updates but no notifications on user", async () => {
    const email = "sse-statuses-only@example.com";
    const stream = await openEventStream("/user", { email, scopes: ["read:statuses"] });
    await follow("sse-statuses-follower@example.com", email);
    const id = await post(email, "no notification for me");
    const heard = await stream.next();
    expect(heard.event).toBe("update");
    expect(statusOf(heard.data).id).toBe(id);
    await stream.cancel();
  });

  it("hold the tagged-stream cap across SSE connections", async () => {
    const email = "sse-cap@example.com";
    const opened = [];
    for (let index = 0; index < MAX_HUB_TAGGED_CHANNELS; index += 1) {
      opened.push(await openEventStream(`/hashtag?tag=ssecap${index}`, { email }));
    }
    const refused = await requestEventStream("/hashtag?tag=ssecapover", { email });
    expect(refused.status).toBe(429);
    for (const stream of opened) {
      await stream.cancel();
    }
    await eventually(opened[0]?.hub ?? "", 0);
  });

  it("refuse an SSE connection past the per-account limit, and admit one after a disconnect", async () => {
    const email = "sse-connections@example.com";
    const opened = [];
    for (let index = 0; index < MAX_ACCOUNT_EVENT_STREAMS; index += 1) {
      opened.push(await openEventStream("/public", { email }));
    }
    const refused = await requestEventStream("/public", { email });
    expect(refused.status).toBe(429);
    await opened[0]?.cancel();
    let admitted = await requestEventStream("/public", { email });
    for (let attempt = 0; admitted.status === 429 && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      admitted = await requestEventStream("/public", { email });
    }
    expect(admitted.status).toBe(200);
    await admitted.body?.cancel();
    for (const stream of opened.slice(1)) {
      await stream.cancel();
    }
  });

  it("drop the registry row when the client disconnects, and keep it while another connection holds it", async () => {
    const email = "sse-cleanup@example.com";
    const first = await openEventStream("/hashtag?tag=ssecleanup", { email });
    const second = await openEventStream("/hashtag?tag=ssecleanup", { email });
    await eventually(first.hub, 1);
    await first.cancel();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await rows(first.hub)).toBe(1);
    await second.cancel();
    await eventually(first.hub, 0);
  });

  it("send a :thump comment on every heartbeat", async () => {
    const stream = await openEventStream("/public/remote");
    expect(await stream.frame(SSE_HEARTBEAT_MS + 5_000)).toEqual({
      kind: "Comment",
      text: "thump",
    });
    await stream.cancel();
  }, 30_000);
});
