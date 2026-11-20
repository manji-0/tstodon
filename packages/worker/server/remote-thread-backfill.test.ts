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
  THREAD_COLLECTION_REPLY_LIMIT,
  THREAD_REFRESH_RUNNING_LIMIT_MS,
  THREAD_REPLIES_COOLDOWN_MS,
  THREAD_TREE_NODES_PER_JOB,
  THREAD_TREE_PAGE_LIMIT,
  THREAD_TREE_REPLY_LIMIT,
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

/** A URL whose server does not answer: `serving` gives it a 503. */
const DOWN = Symbol("down");

/** Run `body` while `fetch` serves `documents` by URL and 404s anything else. */
const serving = async <T>(
  documents: ReadonlyMap<string, unknown>,
  body: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  const fetched: typeof fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents.get(href);
    if (document === DOWN) {
      return new Response("unavailable", { status: 503 });
    }
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

const runQueued = async (
  recording: ReturnType<typeof recordingEnv>,
  outcome: "ok" | "retry" = "ok",
) => {
  // A retried job stays queued, as the queue redelivers it.
  const message = outcome === "retry" ? recording.sent[0] : recording.sent.shift();
  const job = OutboxJob.parse(message);
  if (job.isErr()) {
    throw new Error("queued job rejected");
  }
  expect(await processOutboxJob(recording.env, job.value)).toBe(outcome);
};

/** Run the queued jobs until none is left, as the queue would; resolves to how many ran. */
const drain = async (recording: ReturnType<typeof recordingEnv>): Promise<number> => {
  let ran = 0;
  while (recording.sent.length > 0) {
    await runQueued(recording);
    ran += 1;
  }
  return ran;
};

/** When the fetch of the status's thread was closed; null while it runs. */
const finishedAt = async (statusId: string) =>
  (
    await env.DB.prepare("SELECT context_refreshed_at FROM remote_statuses WHERE id = ?")
      .bind(statusId)
      .first<{ context_refreshed_at: string | null }>()
  )?.context_refreshed_at ?? null;

/** A note whose `replies` collection lists `replies` on its first page. */
const withReplies = (
  remote: Remote,
  slug: string,
  replies: ReadonlyArray<string>,
  extra: Record<string, unknown> = {},
) =>
  noteDocument(remote, slug, {
    ...extra,
    replies: {
      id: `${noteUri(remote, slug)}/replies`,
      type: "Collection",
      first: { type: "CollectionPage", items: replies },
    },
  });

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
    expect(recording.sent).toEqual([
      { kind: "BackfillRemoteThread", statusId: openedId, from: { kind: "Root" } },
    ]);

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

  it("fetches an ancestor or a reply of a type Mastodon converts, such as a Lemmy Page", async () => {
    const author = await remoteActor("thread-converted", "thread.example");
    const page = noteDocument(author, "thread-converted-page", {
      type: "Page",
      name: "A Lemmy post",
      content: undefined,
    });
    const opened = withReplies(author, "thread-converted-comment", [
      noteUri(author, "thread-converted-video"),
    ]);
    const comment = { ...opened, inReplyTo: page.id };
    await deliver(author, comment);
    const commentId = await statusIdOf(comment.id);
    const documents = new Map<string, unknown>([
      [comment.id, comment],
      [page.id, page],
      [
        noteUri(author, "thread-converted-video"),
        noteDocument(author, "thread-converted-video", {
          type: "Video",
          name: "A PeerTube answer",
          inReplyTo: comment.id,
        }),
      ],
    ]);
    const recording = recordingEnv();
    await requested(commentId, recording.env);
    await serving(documents, () => drain(recording));

    const context = await contextOf(commentId);
    expect(context.ancestors.map((entry) => entry.uri)).toEqual([page.id]);
    expect(context.descendants.map((entry) => entry.uri)).toEqual([
      noteUri(author, "thread-converted-video"),
    ]);
  });

  it("reads pages of replies until they hold five, as Mastodon serves them", async () => {
    const author = await remoteActor("paged-author", "paged.example");
    const other = await remoteActor("paged-other", "paged.example");
    const opened = noteUri(author, "paged-opened");
    const replies = `${opened}/replies`;
    const secondPage = `${replies}?only_other_accounts=true&page=true`;
    const thirdPage = `${replies}?min_id=2&only_other_accounts=true&page=true`;
    const fourthPage = `${replies}?min_id=3&only_other_accounts=true&page=true`;
    const fifthPage = `${replies}?min_id=5&only_other_accounts=true&page=true`;
    const elsewhere = "https://elsewhere.example/replies?page=true";
    // Mastodon 4.7's shape: the author's own replies inline, the rest behind `next`.
    const openedNote = noteDocument(author, "paged-opened", {
      replies: {
        id: replies,
        type: "Collection",
        first: {
          type: "CollectionPage",
          next: secondPage,
          partOf: replies,
          items: [noteUri(author, "paged-own-reply")],
        },
      },
    });
    await deliver(author, openedNote);
    const openedId = await statusIdOf(opened);
    const reply = (remote: Remote, slug: string): [string, unknown] => [
      noteUri(remote, slug),
      noteDocument(remote, slug, { inReplyTo: opened }),
    ];
    const page = (id: string, items: string[], next?: string) => ({
      id,
      type: "CollectionPage",
      partOf: replies,
      items,
      ...(next ? { next } : {}),
    });
    const documents = new Map<string, unknown>([
      [opened, openedNote],
      reply(author, "paged-own-reply"),
      reply(other, "paged-other-reply-1"),
      reply(other, "paged-other-reply-2"),
      reply(other, "paged-other-reply-3"),
      reply(other, "paged-other-reply-4"),
      reply(other, "paged-beyond-the-pages"),
      [secondPage, page(secondPage, [noteUri(other, "paged-other-reply-1")], thirdPage)],
      [thirdPage, page(thirdPage, [noteUri(other, "paged-other-reply-2")], fourthPage)],
      [
        fourthPage,
        page(
          fourthPage,
          [noteUri(other, "paged-other-reply-3"), noteUri(other, "paged-other-reply-4")],
          fifthPage,
        ),
      ],
      [fifthPage, page(fifthPage, [noteUri(other, "paged-beyond-the-pages")])],
    ]);
    const recording = recordingEnv();

    await requested(openedId, recording.env);
    await serving(documents, () => runQueued(recording));

    // Five replies on four pages; the fifth page is not read.
    expect((await contextOf(openedId)).descendants.map((entry) => entry.uri)).toEqual([
      noteUri(author, "paged-own-reply"),
      noteUri(other, "paged-other-reply-1"),
      noteUri(other, "paged-other-reply-2"),
      noteUri(other, "paged-other-reply-3"),
      noteUri(other, "paged-other-reply-4"),
    ]);

    // A `next` on another origin is not followed.
    const strayAuthor = await remoteActor("paged-stray", "paged.example");
    const stray = noteUri(strayAuthor, "paged-stray-opened");
    const strayNote = noteDocument(strayAuthor, "paged-stray-opened", {
      replies: {
        id: `${stray}/replies`,
        type: "Collection",
        first: { type: "CollectionPage", next: elsewhere, items: [] },
      },
    });
    await deliver(strayAuthor, strayNote);
    const strayId = await statusIdOf(stray);
    await requested(strayId, recording.env);
    await serving(
      new Map<string, unknown>([
        [stray, strayNote],
        [elsewhere, page(elsewhere, [noteUri(other, "paged-beyond-the-pages")])],
      ]),
      () => runQueued(recording),
    );
    expect((await contextOf(strayId)).descendants).toEqual([]);
  });

  it("retries, and does not close the fetch, while a page of replies does not answer", async () => {
    const author = await remoteActor("down-author", "down.example");
    const other = await remoteActor("down-other", "down.example");
    const opened = noteUri(author, "down-opened");
    const replies = `${opened}/replies`;
    const secondPage = `${replies}?only_other_accounts=true&page=true`;
    const openedNote = noteDocument(author, "down-opened", {
      replies: {
        id: replies,
        type: "Collection",
        first: {
          type: "CollectionPage",
          next: secondPage,
          items: [noteUri(author, "down-own-reply")],
        },
      },
    });
    await deliver(author, openedNote);
    const openedId = await statusIdOf(opened);
    const documents = new Map<string, unknown>([
      [opened, openedNote],
      [
        noteUri(author, "down-own-reply"),
        noteDocument(author, "down-own-reply", { inReplyTo: opened }),
      ],
      [
        noteUri(other, "down-other-reply"),
        noteDocument(other, "down-other-reply", { inReplyTo: opened }),
      ],
    ]);
    const finished = async () =>
      (
        await env.DB.prepare("SELECT context_refreshed_at FROM remote_statuses WHERE id = ?")
          .bind(openedId)
          .first<{ context_refreshed_at: string | null }>()
      )?.context_refreshed_at;
    const recording = recordingEnv();
    await requested(openedId, recording.env);

    await serving(new Map([...documents, [secondPage, DOWN]]), () => runQueued(recording, "retry"));
    expect(await finished()).toBeNull();
    expect((await contextOf(openedId)).descendants).toEqual([]);

    await serving(
      new Map<string, unknown>([
        ...documents,
        [
          secondPage,
          { id: secondPage, type: "CollectionPage", items: [noteUri(other, "down-other-reply")] },
        ],
      ]),
      () => drain(recording),
    );
    expect(await finished()).not.toBeNull();
    expect((await contextOf(openedId)).descendants.map((entry) => entry.uri)).toEqual([
      noteUri(author, "down-own-reply"),
      noteUri(other, "down-other-reply"),
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

  it(`stores every reply a collection lists, ${THREAD_BACKFILL_REPLY_LIMIT} a job`, async () => {
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
    const storedCount = async () =>
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM remote_statuses WHERE actor_uri = ?")
          .bind(author.actorUri)
          .first<{ n: number }>()
      )?.n;

    await requested(await statusIdOf(opened.id), recording.env);
    await serving(documents, () => runQueued(recording));
    expect(await storedCount()).toBe(1 + THREAD_BACKFILL_REPLY_LIMIT);

    await serving(documents, () => drain(recording));
    expect(await storedCount()).toBe(1 + count);
  });

  it(`keeps at most ${THREAD_COLLECTION_REPLY_LIMIT} of the replies one collection lists`, async () => {
    const author = await remoteActor("thread-huge", "thread.example");
    const replyUris = Array.from({ length: THREAD_COLLECTION_REPLY_LIMIT + 5 }, (_, index) =>
      noteUri(author, `huge-reply-${index}`),
    );
    const opened = noteDocument(author, "huge-opened", {
      replies: { type: "Collection", first: { type: "CollectionPage", items: replyUris } },
    });
    await deliver(author, opened);
    const recording = recordingEnv();

    await requested(await statusIdOf(opened.id), recording.env);
    await serving(new Map([[opened.id, opened]]), () => runQueued(recording));

    const Next = z.object({ from: z.object({ listed: z.number(), offset: z.number() }) });
    expect(read(Next, recording.sent[0]).from).toEqual(
      expect.objectContaining({
        listed: THREAD_COLLECTION_REPLY_LIMIT,
        offset: THREAD_BACKFILL_REPLY_LIMIT,
      }),
    );
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

describe("the reply tree of an opened remote status", () => {
  it("is walked a level at a time in queued jobs, and the fetch closes with the last", async () => {
    const author = await remoteActor("tree-author", "tree.example");
    const other = await remoteActor("tree-other", "tree.example");
    const elsewhere = await remoteActor("tree-elsewhere", "elsewhere.example");
    const slugs = ["tree-1", "tree-2", "tree-3"];
    const [first, second, third] = [
      noteUri(other, slugs[0] ?? ""),
      noteUri(author, slugs[1] ?? ""),
      noteUri(other, slugs[2] ?? ""),
    ];
    const root = withReplies(author, "tree-root", [first]);
    await deliver(author, root);
    const rootId = await statusIdOf(root.id);
    // The third's `replies` is on another origin, which is not read.
    const stray = noteUri(elsewhere, "tree-stray");
    const documents = new Map<string, unknown>([
      [root.id, root],
      [first, withReplies(other, slugs[0] ?? "", [second], { inReplyTo: root.id })],
      [second, withReplies(author, slugs[1] ?? "", [third], { inReplyTo: first })],
      [
        third,
        noteDocument(other, slugs[2] ?? "", {
          inReplyTo: second,
          replies: "https://elsewhere.example/replies",
        }),
      ],
      [
        "https://elsewhere.example/replies",
        { id: "https://elsewhere.example/replies", type: "Collection", items: [stray] },
      ],
      [stray, noteDocument(elsewhere, "tree-stray", { inReplyTo: third })],
    ]);
    const recording = recordingEnv();
    await requested(rootId, recording.env);

    await serving(documents, async () => {
      // The first pass and the jobs for levels 1 and 2.
      for (let job = 0; job < 3; job += 1) {
        await runQueued(recording);
      }
      expect(await finishedAt(rootId)).toBeNull();
      // Level 3, then an empty level 4.
      expect(await drain(recording)).toBe(2);
    });

    expect(await finishedAt(rootId)).not.toBeNull();
    expect((await contextOf(rootId)).descendants.map((entry) => entry.uri)).toEqual([
      first,
      second,
      third,
    ]);
  });

  it(`expands at most ${THREAD_TREE_NODES_PER_JOB} replies a job and goes on in the next`, async () => {
    const author = await remoteActor("wide-author", "tree.example");
    const count = THREAD_TREE_NODES_PER_JOB + 2;
    const replyUris = Array.from({ length: count }, (_, index) => noteUri(author, `wide-${index}`));
    const leaf = (index: number) => noteUri(author, `wide-leaf-${index}`);
    const root = withReplies(author, "wide-root", replyUris);
    await deliver(author, root);
    const rootId = await statusIdOf(root.id);
    const documents = new Map<string, unknown>([
      [root.id, root],
      ...replyUris.map(
        (uri, index) =>
          [
            uri,
            withReplies(author, `wide-${index}`, [leaf(index)], { inReplyTo: root.id }),
          ] as const,
      ),
      ...replyUris.map(
        (uri, index) =>
          [leaf(index), noteDocument(author, `wide-leaf-${index}`, { inReplyTo: uri })] as const,
      ),
    ]);
    const recording = recordingEnv();
    await requested(rootId, recording.env);

    const levels: unknown[] = [];
    await serving(documents, async () => {
      while (recording.sent.length > 0) {
        levels.push(recording.sent[0]);
        await runQueued(recording);
      }
    });

    const Level = z.object({
      from: z.object({
        kind: z.string(),
        depth: z.number().optional(),
        after: z.string().optional(),
      }),
    });
    expect(levels.map((job) => read(Level, job).from)).toEqual([
      { kind: "Root" },
      expect.objectContaining({ kind: "Level", depth: 1, after: "" }),
      expect.objectContaining({ kind: "Level", depth: 1 }),
      expect.objectContaining({ kind: "Level", depth: 2, after: "" }),
      expect.objectContaining({ kind: "Level", depth: 2 }),
      expect.objectContaining({ kind: "Level", depth: 3, after: "" }),
    ]);
    expect((await contextOf(rootId)).descendants).toHaveLength(2 * count);
  });

  it(`stops once the tree listed ${THREAD_TREE_REPLY_LIMIT} replies or read ${THREAD_TREE_PAGE_LIMIT} pages`, async () => {
    const author = await remoteActor("capped-author", "tree.example");
    const reply = noteUri(author, "capped-reply");
    const root = withReplies(author, "capped-root", [reply]);
    await deliver(author, root);
    const rootId = await statusIdOf(root.id);
    const documents = new Map<string, unknown>([
      [root.id, root],
      [
        reply,
        withReplies(author, "capped-reply", [noteUri(author, "capped-leaf")], {
          inReplyTo: root.id,
        }),
      ],
      [noteUri(author, "capped-leaf"), noteDocument(author, "capped-leaf", { inReplyTo: reply })],
    ]);
    // The first pass stores the reply.
    const setup = recordingEnv();
    await requested(rootId, setup.env);
    await serving(documents, () => runQueued(setup));
    for (const counts of [
      { listed: THREAD_TREE_REPLY_LIMIT - 1, pages: 1 },
      { listed: 1, pages: THREAD_TREE_PAGE_LIMIT - 1 },
    ]) {
      // As if the cooldown since the last walk read the reply had passed.
      await env.DB.prepare(
        "UPDATE remote_statuses SET replies_fetched_at = NULL WHERE object_uri = ?",
      )
        .bind(reply)
        .run();
      const recording = recordingEnv();
      recording.sent.push({
        kind: "BackfillRemoteThread",
        statusId: rootId,
        from: { kind: "Level", depth: 1, after: "", stored: 1, ...counts },
      });
      await serving(documents, () => runQueued(recording));
      // The reply was expanded, and the walk ends there.
      expect(recording.sent).toEqual([]);
      expect(await finishedAt(rootId)).not.toBeNull();
    }
  });

  it("skips a reply whose replies do not answer, as Mastodon does, and goes on", async () => {
    const author = await remoteActor("tree-down", "tree.example");
    const [down, up] = [noteUri(author, "tree-down-1"), noteUri(author, "tree-down-2")];
    const leaf = noteUri(author, "tree-down-leaf");
    const root = withReplies(author, "tree-down-root", [down, up]);
    await deliver(author, root);
    const rootId = await statusIdOf(root.id);
    const documents = new Map<string, unknown>([
      [root.id, root],
      [down, withReplies(author, "tree-down-1", [], { inReplyTo: root.id })],
      [up, withReplies(author, "tree-down-2", [leaf], { inReplyTo: root.id })],
      [leaf, noteDocument(author, "tree-down-leaf", { inReplyTo: up })],
    ]);
    const recording = recordingEnv();
    await requested(rootId, recording.env);
    await serving(documents, () => runQueued(recording));

    await serving(new Map([...documents, [down, DOWN]]), () => drain(recording));

    expect(await finishedAt(rootId)).not.toBeNull();
    expect((await contextOf(rootId)).descendants.map((entry) => entry.uri)).toEqual([
      down,
      up,
      leaf,
    ]);
  });

  it(`goes on to the next level after a slice of exactly ${THREAD_TREE_NODES_PER_JOB} replies`, async () => {
    const author = await remoteActor("full-slice", "tree.example");
    const replies = Array.from({ length: THREAD_TREE_NODES_PER_JOB }, (_, index) =>
      noteUri(author, `full-${index}`),
    );
    const root = withReplies(author, "full-root", replies);
    await deliver(author, root);
    const rootId = await statusIdOf(root.id);
    const leaf = (index: number) => noteUri(author, `full-leaf-${index}`);
    const deep = (index: number) => noteUri(author, `full-deep-${index}`);
    const documents = new Map<string, unknown>([[root.id, root]]);
    replies.forEach((uri, index) => {
      documents.set(
        uri,
        withReplies(author, `full-${index}`, [leaf(index)], { inReplyTo: root.id }),
      );
      documents.set(
        leaf(index),
        withReplies(author, `full-leaf-${index}`, [deep(index)], { inReplyTo: uri }),
      );
      documents.set(
        deep(index),
        noteDocument(author, `full-deep-${index}`, { inReplyTo: leaf(index) }),
      );
    });
    const recording = recordingEnv();
    await requested(rootId, recording.env);
    await serving(documents, () => drain(recording));

    expect((await contextOf(rootId)).descendants).toHaveLength(3 * THREAD_TREE_NODES_PER_JOB);
  });

  it("skips a reply whose replies were read within the cooldown, as Mastodon's fetched_replies_at", async () => {
    const author = await remoteActor("cooldown-author", "tree.example");
    const [recent, stale] = [noteUri(author, "cooldown-recent"), noteUri(author, "cooldown-stale")];
    const leaf = (slug: string) => noteUri(author, `${slug}-leaf`);
    const root = withReplies(author, "cooldown-root", [recent, stale]);
    await deliver(author, root);
    const rootId = await statusIdOf(root.id);
    const documents = new Map<string, unknown>([
      [root.id, root],
      [
        recent,
        withReplies(author, "cooldown-recent", [leaf("cooldown-recent")], { inReplyTo: root.id }),
      ],
      [
        stale,
        withReplies(author, "cooldown-stale", [leaf("cooldown-stale")], { inReplyTo: root.id }),
      ],
      [
        leaf("cooldown-recent"),
        noteDocument(author, "cooldown-recent-leaf", { inReplyTo: recent }),
      ],
      [leaf("cooldown-stale"), noteDocument(author, "cooldown-stale-leaf", { inReplyTo: stale })],
    ]);
    const repliesFetchedAt = async (objectUri: string) =>
      (
        await env.DB.prepare("SELECT replies_fetched_at FROM remote_statuses WHERE object_uri = ?")
          .bind(objectUri)
          .first<{ replies_fetched_at: string | null }>()
      )?.replies_fetched_at ?? null;
    const stamp = (objectUri: string, ago: number) =>
      env.DB.prepare("UPDATE remote_statuses SET replies_fetched_at = ? WHERE object_uri = ?")
        .bind(new Date(Date.now() - ago).toISOString(), objectUri)
        .run();
    const recording = recordingEnv();
    await requested(rootId, recording.env);
    // The first pass stores both replies and records that it read the root's.
    await serving(documents, () => runQueued(recording));
    expect(await repliesFetchedAt(root.id)).not.toBeNull();

    await stamp(recent, THREAD_REPLIES_COOLDOWN_MS - 60_000);
    await stamp(stale, THREAD_REPLIES_COOLDOWN_MS + 60_000);
    const before = Date.now();
    await serving(documents, () => drain(recording));

    expect((await contextOf(rootId)).descendants.map((entry) => entry.uri)).toEqual([
      recent,
      stale,
      leaf("cooldown-stale"),
    ]);
    expect(Date.parse((await repliesFetchedAt(stale)) ?? "")).toBeGreaterThanOrEqual(before - 1000);

    // An opened status whose replies a walk read within the cooldown, as
    // another's reply, is not walked again.
    const walked = withReplies(author, "cooldown-walked", []);
    const child = withReplies(author, "cooldown-child", [noteUri(author, "cooldown-unread")], {
      inReplyTo: walked.id,
    });
    await deliver(author, walked);
    await deliver(author, child);
    await stamp(walked.id, 60_000);
    const again = recordingEnv();
    await requested(await statusIdOf(walked.id), again.env);
    await serving(
      new Map<string, unknown>([
        [walked.id, walked],
        [child.id, child],
        [
          noteUri(author, "cooldown-unread"),
          noteDocument(author, "cooldown-unread", { inReplyTo: child.id }),
        ],
      ]),
      () => drain(again),
    );
    expect(
      (await contextOf(await statusIdOf(walked.id))).descendants.map((entry) => entry.uri),
    ).toEqual([child.id]);
  });

  it("stores no note in the root author's name that another host serves", async () => {
    const author = await remoteActor("forged-author", "tree.example");
    const evil = await remoteActor("forger", "evil.example");
    const evilReply = noteUri(evil, "evil-reply");
    const forged = (slug: string, inReplyTo: string) =>
      noteDocument(evil, slug, { attributedTo: author.actorUri, inReplyTo });
    const rootEmbedded = forged("forged-root-embedded", "x");
    const root = withReplies(author, "forged-root", [evilReply]);
    const rootWithForgery = {
      ...root,
      replies: {
        id: `${root.id}/replies`,
        type: "Collection",
        first: {
          type: "CollectionPage",
          items: [evilReply, { ...rootEmbedded, inReplyTo: root.id }],
        },
      },
    };
    await deliver(author, rootWithForgery);
    const rootId = await statusIdOf(root.id);
    const embedded = forged("forged-embedded", evilReply);
    const linked = noteUri(evil, "forged-linked");
    const documents = new Map<string, unknown>([
      [root.id, rootWithForgery],
      [evilReply, withReplies(evil, "evil-reply", [], { inReplyTo: root.id })],
      [linked, forged("forged-linked", evilReply)],
      [rootEmbedded.id, { ...rootEmbedded, inReplyTo: root.id }],
    ]);
    documents.set(evilReply, {
      ...noteDocument(evil, "evil-reply", { inReplyTo: root.id }),
      replies: {
        id: `${evilReply}/replies`,
        type: "Collection",
        first: { type: "CollectionPage", items: [embedded, linked] },
      },
    });
    const recording = recordingEnv();
    await requested(rootId, recording.env);
    await serving(documents, () => drain(recording));

    const forgeries = await env.DB.prepare(
      "SELECT object_uri FROM remote_statuses WHERE object_uri LIKE 'https://evil.example/notes/forged-%'",
    ).all();
    expect(forgeries.results).toEqual([]);
    expect((await contextOf(rootId)).descendants.map((entry) => entry.uri)).toEqual([evilReply]);
  });
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

    await serving(documents, () => drain(recording));

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
