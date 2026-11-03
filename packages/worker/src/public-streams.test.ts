import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { OutboxJob, type StreamChannelValue } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { type Heard, openStream } from "../test/stream-fixture";
import { processOutboxJob } from "./outbox-job";

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const LOCAL: StreamChannelValue = { kind: "Public", origin: "Local", onlyMedia: false };
const REMOTE: StreamChannelValue = { kind: "Public", origin: "Remote", onlyMedia: false };

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  return { status: response.status, body: await response.json() };
};

const StatusSchema = z.object({ id: z.string(), uri: z.string(), content: z.string() });

const statusOf = (heard: Pick<Heard, "payload">) => {
  const parsed = schemaResult(StatusSchema)(JSON.parse(heard.payload));
  if (parsed.isErr()) {
    throw new Error("status payload rejected");
  }
  return parsed.value;
};

const post = async (
  email: string,
  status: string,
  visibility: string = "public",
): Promise<string> => {
  const posted = await json(email, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status, visibility }),
  });
  expect(posted.status).toBe(200);
  return statusOf({ payload: JSON.stringify(posted.body) }).id;
};

const remoteNote = (author: Remote, slug: string) => ({
  id: `${new URL(author.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
});

/** Store `author`'s note the way an outbox backfill does: fetched, not delivered. */
const backfill = async (author: Remote, slug: string): Promise<void> => {
  const outbox = `${author.actorUri}/outbox`;
  const object = remoteNote(author, slug);
  const documents = new Map<string, unknown>([
    [
      author.actorUri,
      {
        id: author.actorUri,
        type: "Person",
        preferredUsername: new URL(author.actorUri).pathname.split("/").at(-1),
        inbox: `${author.actorUri}/inbox`,
        outbox,
        publicKey: {
          id: `${author.actorUri}#main-key`,
          owner: author.actorUri,
          publicKeyPem: author.publicKeyPem,
        },
      },
    ],
    [outbox, { id: outbox, type: "OrderedCollection", first: `${outbox}?page=true` }],
    [
      `${outbox}?page=true`,
      {
        id: `${outbox}?page=true`,
        type: "OrderedCollectionPage",
        orderedItems: [
          {
            id: `${object.id}/activity`,
            type: "Create",
            actor: author.actorUri,
            published: object.published,
            to: [PUBLIC],
            object,
          },
        ],
      },
    ],
  ]);
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents.get(href);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    const job = OutboxJob.parse({ kind: "BackfillRemoteOutbox", actorUri: author.actorUri });
    if (job.isErr()) {
      throw new Error("backfill job rejected");
    }
    expect(await processOutboxJob(env, job.value)).toBe("ok");
  } finally {
    globalThis.fetch = original;
  }
  const stored = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM remote_statuses WHERE object_uri = ?",
  )
    .bind(object.id)
    .first<{ n: number }>();
  expect(stored?.n).toBe(1);
};

describe("public streams", () => {
  it("carry new public local posts to public:local, not to a user stream", async () => {
    const author = "ps-local-author@example.com";
    const local = await openStream({
      email: "ps-local-viewer@example.com",
      query: "?stream=public:local",
    });
    const anonymous = await openStream({ query: "?stream=public:local" });
    const user = await openStream({ email: "ps-local-user@example.com", query: "?stream=user" });

    await post(author, "unlisted, not public", "unlisted");
    const id = await post(author, "out in public");

    for (const socket of [local, anonymous]) {
      const heard = await socket.next();
      expect(heard).toMatchObject({ stream: ["public:local"], event: "update" });
      expect(statusOf(heard).id).toBe(id);
    }
    expect(await user.heardNothing()).toBe(true);

    const deleted = await json(author, `/api/v1/statuses/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await local.next()).toEqual({ stream: ["public:local"], event: "delete", payload: id });
    for (const socket of [local, anonymous, user]) {
      socket.close();
    }
  });

  it("leave out authors the viewer blocks, and stop on unsubscribe", async () => {
    const author = "ps-block-author@example.com";
    const authorAccount = await signedInAccount(author);
    const blocker = await openStream({ email: "ps-block-blocker@example.com" });
    const quitter = await openStream({ email: "ps-block-quitter@example.com" });
    const viewer = await openStream({ email: "ps-block-viewer@example.com" });
    for (const socket of [blocker, quitter, viewer]) {
      await socket.subscribe({ stream: "public" });
    }
    const blocked = await json(
      "ps-block-blocker@example.com",
      `/api/v1/accounts/${authorAccount.id}/block`,
      { method: "POST", body: "{}" },
    );
    expect(blocked.status).toBe(200);
    const barrier = await quitter.unsubscribe({ stream: "public" });

    const id = await post(author, "blocked by some");

    const heard = await viewer.next();
    expect(heard.stream).toEqual(["public"]);
    expect(statusOf(heard).id).toBe(id);
    expect(await blocker.heardNothing({ kind: "Public", origin: "All", onlyMedia: false })).toBe(
      true,
    );
    expect(await quitter.heardNothing(barrier)).toBe(true);
    for (const socket of [blocker, quitter, viewer]) {
      socket.close();
    }
  });

  it("carry a hashtag's posts to its subscribers, as they spelled the tag", async () => {
    const author = "ps-tag-author@example.com";
    const cats = await openStream({ email: "ps-tag-viewer@example.com" });
    await cats.subscribe({ stream: "hashtag", tag: "Cats" });

    await post(author, "a dog post #dogs");
    const id = await post(author, "a cat post #cats");

    const heard = await cats.next();
    expect(heard).toMatchObject({ stream: ["hashtag", "Cats"], event: "update" });
    expect(statusOf(heard).id).toBe(id);
    expect(await cats.heardNothing({ kind: "Hashtag", tag: "cats", localOnly: false })).toBe(true);
    cats.close();
  });

  it("carry a remote public note delivered live to public:remote, not a backfilled one", async () => {
    const actor = await remoteActor("ps-remote-actor");
    const remote = await openStream({
      email: "ps-remote-viewer@example.com",
      query: "?stream=public:remote",
    });
    const local = await openStream({
      email: "ps-remote-local@example.com",
      query: "?stream=public:local",
    });

    await backfill(actor, "ps-remote-backfilled");
    const object = remoteNote(actor, "ps-remote-live");
    expect(await actor.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);

    const heard = await remote.next();
    expect(heard.stream).toEqual(["public:remote"]);
    expect(statusOf(heard).uri).toBe(object.id);
    expect(await remote.heardNothing(REMOTE)).toBe(true);
    expect(await local.heardNothing(LOCAL)).toBe(true);
    remote.close();
    local.close();
  });

  it("are looked up in rows that follow the hub's sockets", async () => {
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
    const socket = await openStream({
      email: "ps-rows-viewer@example.com",
      query: "?stream=public:local",
    });
    const hub = socket.account?.id ?? "";
    expect(await rows(hub)).toBe(1);
    socket.close();
    await eventually(hub, 0);

    // A row its hub never cleared (an eviction without close events) goes
    // the first time a fan-out finds no socket behind it.
    const stale = (await signedInAccount("ps-rows-stale@example.com")).id;
    await env.DB.prepare(
      "INSERT INTO stream_subscriptions (hub, stream, param) VALUES (?, 'public:local', '')",
    )
      .bind(stale)
      .run();
    await post("ps-rows-author@example.com", "finds a stale row");
    await eventually(stale, 0);
  });
});
