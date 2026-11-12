import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { answerLinkPreviews } from "../test/link-card-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";

const ORIGIN = "https://example.com";

const json = async (email: string, path: string, body: unknown) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

const IdSchema = z.object({ id: z.string() });

const idOf = (body: unknown): string => {
  const parsed = schemaResult(IdSchema)(body);
  if (parsed.isErr()) {
    throw new Error("response without an id");
  }
  return parsed.value.id;
};

const post = async (email: string, status: string): Promise<string> => {
  const posted = await json(email, "/api/v1/statuses", { status });
  expect(posted.status).toBe(200);
  return idOf(posted.body);
};

/** The kinds of the jobs the Worker sends to the outbox queue from now on. */
const recordQueue = (): Readonly<{ kinds: () => string[] }> => {
  const send = vi.spyOn(Object.getPrototypeOf(env.OUTBOX_PROCESS_QUEUE), "send");
  return {
    kinds: () =>
      send.mock.calls.map(([body]) => {
        const kind: unknown =
          typeof body === "object" && body !== null ? Reflect.get(body, "kind") : undefined;
        return typeof kind === "string" ? kind : "";
      }),
  };
};

const fanOutKinds = (kinds: ReadonlyArray<string>): string[] =>
  kinds.filter((kind) => kind === "FanOutHome" || kind === "FanOutPublic");

const subscriptionRows = async (): Promise<number> =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM stream_subscriptions").first<{ n: number }>())
    ?.n ?? 0;

/** Long enough for the work a request started after its response to finish. */
const afterResponseSettled = () => new Promise((resolve) => setTimeout(resolve, 500));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stream fan-outs", () => {
  const author = "gate-author@example.com";
  const follower = "gate-follower@example.com";

  it("send nothing when no stream could hear the post", async () => {
    const target = await signedInAccount(author);
    expect((await json(follower, `/api/v1/accounts/${target.id}/follow`, {})).status).toBe(200);
    expect(await subscriptionRows()).toBe(0);
    const queue = recordQueue();

    await post(author, "nobody is streaming");
    await afterResponseSettled();

    expect(fanOutKinds(queue.kinds())).toEqual([]);
  });

  it("send nothing for a remote post with a link while nobody streams", async () => {
    const actor = await remoteActor("gate-remote");
    const link = "https://gate-news.example/story";
    const previews = answerLinkPreviews([link]);
    const queue = recordQueue();
    const object = {
      id: `${new URL(actor.actorUri).origin}/notes/gate`,
      type: "Note",
      attributedTo: actor.actorUri,
      content: `<p>read <a href="${link}">${link}</a></p>`,
      published: new Date().toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      cc: [`${actor.actorUri}/followers`],
    };

    expect(await actor.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);
    await previews.settled();
    await afterResponseSettled();

    expect(queue.kinds()).toEqual([]);
  });

  it("tell open streams after the response, without the queue", async () => {
    const home = await openStream({ email: follower, query: "?stream=user" });
    const local = await openStream({
      email: "gate-viewer@example.com",
      query: "?stream=public:local",
    });
    const queue = recordQueue();

    const id = await post(author, "someone is streaming");

    for (const stream of [home, local]) {
      const heard = await stream.next();
      expect(heard.event).toBe("update");
      expect(idOf(JSON.parse(heard.payload))).toBe(id);
    }
    expect(fanOutKinds(queue.kinds())).toEqual([]);
    home.close();
    local.close();

    // Once the streams are gone, the next post sends nothing again.
    await vi.waitFor(async () => expect(await subscriptionRows()).toBe(0));
    const after = recordQueue();
    await post(author, "everyone left");
    await afterResponseSettled();
    expect(fanOutKinds(after.kinds())).toEqual([]);
  });
});
