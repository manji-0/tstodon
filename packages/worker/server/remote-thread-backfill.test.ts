import { SELF, env } from "cloudflare:test";
import { ApiAsyncRefresh } from "@tstodon/api";
import { OutboxJob } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";
import { findRemoteStatusById } from "./remote-status-store";
import {
  requestRemoteThreadBackfill,
  THREAD_BACKFILL_ANCESTOR_LIMIT,
  THREAD_BACKFILL_REPLY_LIMIT,
  THREAD_REFRESH_RUNNING_LIMIT_MS,
  threadRefreshOf,
} from "./remote-thread-backfill";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const noteUri = (remote: Remote, slug: string): string =>
  `${new URL(remote.actorUri).origin}/notes/${slug}`;

// Each fixture note is published a second after the last, so notes sort in the
// order the test builds them (same-instant ids only order by their random bits).
let published = Date.parse("2024-03-03T00:00:00.000Z");

const noteDocument = (remote: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: noteUri(remote, slug),
  type: "Note",
  attributedTo: remote.actorUri,
  content: `<p>${slug}</p>`,
  published: new Date((published += 1000)).toISOString(),
  to: [PUBLIC],
  cc: [`${remote.actorUri}/followers`],
  ...extra,
});

/** Run `body` while `fetch` serves `documents` by URL and 404s anything else. */
const serving = async <T>(
  documents: ReadonlyMap<string, unknown>,
  body: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  const fetched: typeof fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents.get(href);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  globalThis.fetch = fetched;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
};

const recordingEnv = () => {
  const sent: unknown[] = [];
  const queue = {
    send: async (message: unknown) => {
      sent.push(message);
    },
  };
  const proxied = new Proxy(env, {
    get: (target, key) => (key === "OUTBOX_PROCESS_QUEUE" ? queue : Reflect.get(target, key)),
  });
  return { env: proxied, sent };
};

const ContextSchema = z.object({
  ancestors: z.array(z.object({ uri: z.string() })),
  descendants: z.array(z.object({ uri: z.string() })),
});

const statusIdOf = async (objectUri: string): Promise<string> => {
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("remote note was not stored");
  }
  return row.id;
};

const contextOf = async (statusId: string) =>
  read(
    ContextSchema,
    await (await SELF.fetch(`https://example.com/api/v1/statuses/${statusId}/context`)).json(),
  );

const deliver = async (author: Remote, object: ReturnType<typeof noteDocument>) =>
  expect(await author.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);

const requested = async (statusId: string, target: Env) => {
  const status = await findRemoteStatusById(env.DB, statusId);
  if (status.isErr() || !status.value) {
    throw new Error("status not stored");
  }
  await requestRemoteThreadBackfill(target, status.value);
};

const runQueued = async (recording: ReturnType<typeof recordingEnv>) => {
  const message = recording.sent.shift();
  const job = OutboxJob.parse(message);
  if (job.isErr()) {
    throw new Error("queued job rejected");
  }
  expect(await processOutboxJob(recording.env, job.value)).toBe("ok");
};

describe("opening a remote status", () => {
  it("fetches its ancestors and listed replies once, off the request path", async () => {
    const author = await remoteActor("thread-author", "thread.example");
    const opened = noteDocument(author, "thread-opened", {
      inReplyTo: noteUri(author, "thread-parent"),
      replies: {
        id: `${noteUri(author, "thread-opened")}/replies`,
        type: "Collection",
        first: {
          type: "CollectionPage",
          items: [
            noteUri(author, "thread-reply-link"),
            noteDocument(author, "thread-reply-embedded", {
              inReplyTo: noteUri(author, "thread-opened"),
            }),
          ],
        },
      },
    });
    await deliver(author, opened);
    const openedId = await statusIdOf(opened.id);
    const documents = new Map<string, unknown>([
      [opened.id, opened],
      [
        noteUri(author, "thread-parent"),
        noteDocument(author, "thread-parent", { inReplyTo: noteUri(author, "thread-root") }),
      ],
      [noteUri(author, "thread-root"), noteDocument(author, "thread-root")],
      [
        noteUri(author, "thread-reply-link"),
        noteDocument(author, "thread-reply-link", { inReplyTo: opened.id }),
      ],
    ]);
    const recording = recordingEnv();

    expect(await contextOf(openedId)).toEqual({ ancestors: [], descendants: [] });
    const queuedByView = await env.DB.prepare(
      "SELECT context_fetched_at FROM remote_statuses WHERE id = ?",
    )
      .bind(openedId)
      .first<{ context_fetched_at: string | null }>();
    expect(queuedByView?.context_fetched_at).not.toBeNull();

    await env.DB.prepare("UPDATE remote_statuses SET context_fetched_at = NULL WHERE id = ?")
      .bind(openedId)
      .run();
    await Promise.all([requested(openedId, recording.env), requested(openedId, recording.env)]);
    expect(recording.sent).toEqual([{ kind: "BackfillRemoteThread", statusId: openedId }]);

    await serving(documents, () => runQueued(recording));

    expect((await contextOf(openedId)).ancestors.map((entry) => entry.uri)).toEqual([
      noteUri(author, "thread-root"),
      noteUri(author, "thread-parent"),
    ]);
    // Descendants are in id order, and backfilled ids follow `published`: the
    // embedded reply was written first.
    expect((await contextOf(openedId)).descendants.map((entry) => entry.uri)).toEqual([
      noteUri(author, "thread-reply-embedded"),
      noteUri(author, "thread-reply-link"),
    ]);
  });

  it(`walks at most ${THREAD_BACKFILL_ANCESTOR_LIMIT} notes up`, async () => {
    const author = await remoteActor("thread-deep", "thread.example");
    const depth = THREAD_BACKFILL_ANCESTOR_LIMIT + 2;
    const slug = (level: number) => `deep-${level}`;
    const opened = noteDocument(author, slug(0), { inReplyTo: noteUri(author, slug(1)) });
    await deliver(author, opened);
    const documents = new Map<string, unknown>();
    for (let level = 1; level <= depth; level += 1) {
      documents.set(
        noteUri(author, slug(level)),
        noteDocument(
          author,
          slug(level),
          level < depth ? { inReplyTo: noteUri(author, slug(level + 1)) } : {},
        ),
      );
    }
    const recording = recordingEnv();
    const openedId = await statusIdOf(opened.id);

    await requested(openedId, recording.env);
    await serving(documents, () => runQueued(recording));

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM remote_statuses WHERE actor_uri = ?",
    )
      .bind(author.actorUri)
      .first<{ n: number }>();
    expect(stored?.n).toBe(1 + THREAD_BACKFILL_ANCESTOR_LIMIT);
  });

  it(`stores at most ${THREAD_BACKFILL_REPLY_LIMIT} replies`, async () => {
    const author = await remoteActor("thread-many", "thread.example");
    const count = THREAD_BACKFILL_REPLY_LIMIT + 5;
    const replyUris = Array.from({ length: count }, (_, index) =>
      noteUri(author, `many-reply-${index}`),
    );
    const opened = noteDocument(author, "many-opened", {
      replies: { type: "Collection", first: { type: "CollectionPage", items: replyUris } },
    });
    await deliver(author, opened);
    const documents = new Map<string, unknown>([
      [opened.id, opened],
      ...replyUris.map(
        (uri, index) =>
          [uri, noteDocument(author, `many-reply-${index}`, { inReplyTo: opened.id })] as const,
      ),
    ]);
    const recording = recordingEnv();

    await requested(await statusIdOf(opened.id), recording.env);
    await serving(documents, () => runQueued(recording));

    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM remote_statuses WHERE actor_uri = ?",
    )
      .bind(author.actorUri)
      .first<{ n: number }>();
    expect(stored?.n).toBe(1 + THREAD_BACKFILL_REPLY_LIMIT);
  });

  it("does not fetch the thread of a followers-only status", async () => {
    const author = await remoteActor("thread-private", "thread.example");
    const opened = noteDocument(author, "private-opened", {
      to: [`${author.actorUri}/followers`],
      cc: [],
    });
    await deliver(author, opened);
    const recording = recordingEnv();

    await requested(await statusIdOf(opened.id), recording.env);

    expect(recording.sent).toEqual([]);
  });
});

const READER = "async-refresh-reader@example.com";

const contextResponse = async (statusId: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`https://example.com/api/v1/statuses/${statusId}/context`, { headers });

const asyncRefresh = async (id: string, headers: Record<string, string>) =>
  SELF.fetch(`https://example.com/api/v1_alpha/async_refreshes/${encodeURIComponent(id)}`, {
    headers,
  });

describe("Mastodon async refresh of a remote thread", () => {
  it("tells a signed-in reader to poll the fetch the view queued", async () => {
    const author = await remoteActor("refresh-header", "thread.example");
    const opened = noteDocument(author, "refresh-header-opened");
    await deliver(author, opened);
    const openedId = await statusIdOf(opened.id);

    const response = await contextResponse(openedId, await authHeaders(READER));

    expect(response.status).toBe(200);
    expect(response.headers.get("Mastodon-Async-Refresh")).toBe(
      `id="context:${openedId}:refresh", retry=3, result_count=0`,
    );
  });

  it("sends no header to an anonymous reader", async () => {
    const author = await remoteActor("refresh-anonymous", "thread.example");
    const opened = noteDocument(author, "refresh-anonymous-opened");
    await deliver(author, opened);

    const anonymous = await contextResponse(await statusIdOf(opened.id));

    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("Mastodon-Async-Refresh")).toBeNull();
  });

  it("reports the fetch running, then finished with the statuses it stored", async () => {
    const author = await remoteActor("refresh-lifecycle", "thread.example");
    const opened = noteDocument(author, "refresh-opened", {
      inReplyTo: noteUri(author, "refresh-parent"),
      replies: {
        type: "Collection",
        first: { type: "CollectionPage", items: [noteUri(author, "refresh-reply")] },
      },
    });
    await deliver(author, opened);
    const openedId = await statusIdOf(opened.id);
    const documents = new Map<string, unknown>([
      [opened.id, opened],
      [noteUri(author, "refresh-parent"), noteDocument(author, "refresh-parent")],
      [
        noteUri(author, "refresh-reply"),
        noteDocument(author, "refresh-reply", { inReplyTo: opened.id }),
      ],
    ]);
    const recording = recordingEnv();
    const headers = await authHeaders(READER);
    const id = `context:${openedId}:refresh`;

    await requested(openedId, recording.env);

    const pending = await contextResponse(openedId, headers);
    expect(pending.headers.get("Mastodon-Async-Refresh")).toBe(
      `id="${id}", retry=3, result_count=0`,
    );
    const running = await asyncRefresh(id, headers);
    expect(running.status).toBe(200);
    expect(read(ApiAsyncRefresh, await running.json())).toEqual({
      async_refresh: { id, status: "running", result_count: 0 },
    });

    await serving(documents, () => runQueued(recording));

    const finished = await asyncRefresh(id, headers);
    expect(read(ApiAsyncRefresh, await finished.json())).toEqual({
      async_refresh: { id, status: "finished", result_count: 2 },
    });
    const settled = await contextResponse(openedId, headers);
    expect(settled.headers.get("Mastodon-Async-Refresh")).toBeNull();
    expect(read(ContextSchema, await settled.json()).descendants.map((entry) => entry.uri)).toEqual(
      [noteUri(author, "refresh-reply")],
    );
  });

  it("answers 404 for an id that names no fetch", async () => {
    const author = await remoteActor("refresh-unknown", "thread.example");
    const unopened = noteDocument(author, "refresh-unopened");
    await deliver(author, unopened);
    const headers = await authHeaders(READER);

    for (const id of [
      `context:${await statusIdOf(unopened.id)}:refresh`,
      "context:999999999999999999:refresh",
      "context::refresh",
      "forged",
    ]) {
      expect((await asyncRefresh(id, headers)).status, id).toBe(404);
    }
  });

  it("requires a signed-in user", async () => {
    expect((await asyncRefresh("context:1:refresh", {})).status).toBe(401);
  });

  it("reads a claim its job never closed as finished once the limit passes", () => {
    const now = Date.parse("2024-03-03T00:10:00.000Z");
    const claimedAt = new Date(now - THREAD_REFRESH_RUNNING_LIMIT_MS - 1).toISOString();

    expect(threadRefreshOf({ claimedAt, finishedClaim: null, resultCount: null }, now)).toEqual({
      kind: "Finished",
      resultCount: 0,
    });
    expect(
      threadRefreshOf(
        { claimedAt: new Date(now).toISOString(), finishedClaim: null, resultCount: null },
        now,
      ),
    ).toEqual({ kind: "Running" });
  });
});
