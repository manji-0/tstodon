import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { OutboxJob, StatusId } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { fanOutHomePage, HOME_FAN_OUT_PAGE_SIZE } from "./home-fan-out";
import { parseInstanceIdentity } from "./runtime-config";
import { publishToAccount } from "./stream-publish";

const ORIGIN = "https://example.com";

const MessageSchema = z.object({
  stream: z.array(z.string()),
  event: z.string(),
  payload: z.string(),
});

const StatusPayloadSchema = z.object({
  id: z.string(),
  content: z.string(),
  account: z.object({ id: z.string() }),
  reblog: z.object({ id: z.string() }).nullable(),
});

type Heard = Readonly<{ event: string; payload: string }>;

const parseMessage = (raw: unknown): Heard => {
  const parsed = schemaResult(MessageSchema)(typeof raw === "string" ? JSON.parse(raw) : raw);
  if (parsed.isErr()) {
    throw new Error("stream message rejected");
  }
  return parsed.value;
};

/** The status an `update` or `status.update` carries. */
const statusOf = (heard: Heard) => {
  const parsed = schemaResult(StatusPayloadSchema)(JSON.parse(heard.payload));
  if (parsed.isErr()) {
    throw new Error("status payload rejected");
  }
  return parsed.value;
};

/** The `user` stream of the account signed in as `email`, read one message at a time. */
const openStream = async (email: string) => {
  const account = await signedInAccount(email);
  const upgrade = await SELF.fetch(`${ORIGIN}/api/v1/streaming`, {
    headers: { ...(await authHeaders(email)), Upgrade: "websocket" },
  });
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket;
  if (!socket) {
    throw new Error("missing websocket");
  }
  socket.accept();
  const heard: Heard[] = [];
  const waiting: ((message: Heard) => void)[] = [];
  socket.addEventListener("message", (message) => {
    const parsed = parseMessage(message.data);
    const waiter = waiting.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      heard.push(parsed);
    }
  });
  const next = (): Promise<Heard> => {
    const queued = heard.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${email} heard nothing`)), 10_000);
      waiting.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  };
  /**
   * Whether the stream stayed quiet until now: a marker published to it after
   * the events under test have reached others must be the next thing heard.
   */
  const heardNothing = async (): Promise<boolean> => {
    const marker = StatusId.parse(`9${Date.now()}`);
    if (marker.isErr()) {
      throw new Error("marker id rejected");
    }
    await publishToAccount(env, account.id, { kind: "delete", statusId: marker.value });
    const first = await next();
    return first.event === "delete" && first.payload === marker.value;
  };
  return { account, next, heardNothing, close: () => socket.close() };
};

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(await authHeaders(email)),
    },
  });
  return { status: response.status, body: await response.json() };
};

const post = async (email: string, status: string): Promise<string> => {
  const posted = await json(email, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  expect(posted.status).toBe(200);
  return statusOf({ event: "update", payload: JSON.stringify(posted.body) }).id;
};

const follow = async (email: string, targetEmail: string, options: object = {}) => {
  const target = await signedInAccount(targetEmail);
  const followed = await json(email, `/api/v1/accounts/${target.id}/follow`, {
    method: "POST",
    body: JSON.stringify(options),
  });
  expect(followed.status).toBe(200);
};

describe("home streams of local followers", () => {
  it("hear a followed account's new post, unless they mute its author", async () => {
    const author = "hs-post-author@example.com";
    // Created first, so a fan-out reaches the muter before the follower.
    const muter = await openStream("hs-post-muter@example.com");
    const follower = await openStream("hs-post-follower@example.com");
    const stranger = await openStream("hs-post-stranger@example.com");
    await follow("hs-post-muter@example.com", author);
    await follow("hs-post-follower@example.com", author);
    const authorAccount = await signedInAccount(author);
    expect(
      (
        await json("hs-post-muter@example.com", `/api/v1/accounts/${authorAccount.id}/mute`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(200);

    const id = await post(author, "fan out to followers");

    const heard = await follower.next();
    expect(heard.event).toBe("update");
    expect(statusOf(heard)).toMatchObject({ id, account: { id: authorAccount.id } });
    expect(await muter.heardNothing()).toBe(true);
    expect(await stranger.heardNothing()).toBe(true);
    for (const stream of [muter, follower, stranger]) {
      stream.close();
    }
  });

  it("hear a followed account's boost, edit, and delete", async () => {
    const author = "hs-life-author@example.com";
    const booster = "hs-life-booster@example.com";
    const follower = await openStream("hs-life-follower@example.com");
    await follow("hs-life-follower@example.com", booster);
    const original = await post(author, "boost me");

    const boosted = await json(booster, `/api/v1/statuses/${original}/reblog`, {
      method: "POST",
      body: "{}",
    });
    expect(boosted.status).toBe(200);
    const boost = statusOf(await follower.next());
    expect(boost.reblog).toMatchObject({ id: original });

    const own = await post(booster, "before the edit");
    expect(statusOf(await follower.next()).id).toBe(own);
    const edited = await json(booster, `/api/v1/statuses/${own}`, {
      method: "PUT",
      body: JSON.stringify({ status: "after the edit" }),
    });
    expect(edited.status).toBe(200);
    const update = await follower.next();
    expect(update.event).toBe("status.update");
    expect(statusOf(update)).toMatchObject({ id: own, content: expect.stringContaining("after") });

    const deleted = await json(booster, `/api/v1/statuses/${own}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await follower.next()).toEqual({ stream: ["user"], event: "delete", payload: own });

    const unboosted = await json(booster, `/api/v1/statuses/${original}/unreblog`, {
      method: "POST",
      body: "{}",
    });
    expect(unboosted.status).toBe(200);
    expect(await follower.next()).toEqual({ stream: ["user"], event: "delete", payload: boost.id });
    follower.close();
  });

  it("are told one page of followers at a time", async () => {
    const author = "hs-paged-author@example.com";
    const opened = [
      await openStream("hs-paged-one@example.com"),
      await openStream("hs-paged-two@example.com"),
    ];
    await follow("hs-paged-one@example.com", author);
    await follow("hs-paged-two@example.com", author);
    const id = await post(author, "paged");
    // The queued fan-out tells both; drain it before driving pages by hand.
    for (const stream of opened) {
      expect(statusOf(await stream.next()).id).toBe(id);
    }
    const [first, second] = opened.toSorted((left, right) =>
      left.account.id.localeCompare(right.account.id),
    );
    const identity = parseInstanceIdentity(env);
    const job = OutboxJob.parse({
      kind: "FanOutHome",
      event: "update",
      entryId: id,
      author: { kind: "LocalAccount", accountId: (await signedInAccount(author)).id },
      afterAccountId: "",
    });
    if (!first || !second || identity.isErr() || job.isErr() || job.value.kind !== "FanOutHome") {
      throw new Error("fan-out fixture rejected");
    }
    expect(HOME_FAN_OUT_PAGE_SIZE).toBeGreaterThan(2);
    const fanOut = job.value;
    const page = (afterAccountId: string) =>
      fanOutHomePage(env, identity.value, { ...fanOut, afterAccountId }, 1);

    const firstPage = await page("");
    expect(firstPage.isOk() && firstPage.value).toBe(first.account.id);
    expect(statusOf(await first.next()).id).toBe(id);
    expect(await second.heardNothing()).toBe(true);

    // A full page always hands on a cursor; the page after the last follower is empty.
    const secondPage = await page(first.account.id);
    expect(secondPage.isOk() && secondPage.value).toBe(second.account.id);
    expect(statusOf(await second.next()).id).toBe(id);
    const lastPage = await page(second.account.id);
    expect(lastPage.isOk() && lastPage.value).toBe(undefined);
    for (const stream of opened) {
      stream.close();
    }
  });
});
