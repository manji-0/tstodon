import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import migration from "../app/db/migrations/0136_remote_tag_reindex.sql?raw";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";
import { indexMissingRemoteTags } from "./remote-status-store";

const json = async (path: string): Promise<unknown> =>
  (await SELF.fetch(`https://example.com${path}`)).json();

const hashtagHtml = (tag: string): string =>
  `<a class="mention hashtag" rel="tag" href="https://remote.example/tags/${tag}">#<span>${tag}</span></a>`;

/** A note stored as one delivered before tags were read from `tag`: content only. */
const stored = async (author: Remote, slug: string, content: string): Promise<string> => {
  const id = `https://remote.example/notes/${slug}`;
  expect(
    await author.send({
      id: `${id}/create`,
      type: "Create",
      object: {
        id,
        type: "Note",
        attributedTo: author.actorUri,
        content,
        published: "2026-10-20T00:00:00.000Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    }),
  ).toBe(202);
  const rows = parseRows(
    z.object({ id: z.string() }),
    (await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?").bind(id).all())
      .results,
  );
  return rows[0]?.id ?? "";
};

const tagNames = async (id: string): Promise<string[]> =>
  expectContract(ApiStatus, await json(`/api/v1/statuses/${id}`)).tags.map((tag) => tag.name);

const timelineIds = async (tag: string, limit: number = 20): Promise<string[]> =>
  expectContract(
    z.array(ApiStatus),
    await json(`/api/v1/timelines/tag/${encodeURIComponent(tag)}?remote=true&limit=${limit}`),
  ).map((status) => status.id);

const searchNames = async (query: string): Promise<string[]> =>
  z
    .object({ hashtags: z.array(z.object({ name: z.string() })) })
    .parse(await json(`/api/v2/search?q=${query}&type=hashtags`))
    .hashtags.map((tag) => tag.name);

/** `db`, running `land` before each batch: what another request writes between a read and its write. */
const beforeBatch = (db: D1Database, land: () => Promise<void>): D1Database =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          await land();
          return target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function"
        ? (...args: unknown[]) => Reflect.apply(value, target, args)
        : value;
    },
  });

const pending = async (prefix: string): Promise<unknown> =>
  env.DB.prepare(
    "SELECT COUNT(*) AS count FROM remote_statuses WHERE tags_indexed = 0 AND object_uri LIKE ? || '%'",
  )
    .bind(`https://remote.example/notes/${prefix}`)
    .first();

const runMigration = async (): Promise<void> => {
  const statement = migration
    .split("\n")
    .filter((line) => !line.startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;$/, "");
  await env.DB.prepare(statement).run();
};

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the remote tag reindex", () => {
  it("indexes the stored statuses that can hold a non-ASCII tag again, from their HTML", async () => {
    const author = await remoteActor("rtr-author");
    const unicode = await stored(
      author,
      "rtr-unicode",
      `<p>${hashtagHtml("日本語")} ${hashtagHtml("rtrascii")}</p>`,
    );
    const ascii = await stored(author, "rtr-ascii", `<p>${hashtagHtml("rtrplain")}</p>`);
    // As stored before: the ASCII tag alone, and marked as indexed.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO remote_status_tags (status_id, tag) VALUES (?, 'rtrascii')").bind(
        unicode,
      ),
      env.DB.prepare("UPDATE remote_statuses SET tags_indexed = 1 WHERE id IN (?, ?)").bind(
        unicode,
        ascii,
      ),
    ]);
    // 250 more, enough for three pages of the job.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
       INSERT INTO remote_statuses
         (id, actor_uri, object_uri, content_html, visibility, published_at, tags_indexed)
       SELECT CAST(CAST(s.id AS INTEGER) - 1000 - i AS TEXT), s.actor_uri,
              printf('https://remote.example/notes/rtr-many-%03d', i),
              '<p>#rtrmany 日本 ' || i || '</p>', s.visibility, s.published_at, 1
       FROM n, (SELECT * FROM remote_statuses WHERE id = ?) s`,
    )
      .bind(unicode)
      .run();
    expect(await tagNames(unicode)).toEqual(["rtrascii"]);
    expect(await timelineIds("日本語")).toEqual([]);

    await runMigration();
    expect(await pending("rtr-")).toEqual({ count: 251 });

    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await indexMissingRemoteTags(env.DB);
      expect(page.isOk()).toBe(true);
      if (page.isErr() || !page.value.chained) {
        break;
      }
    }
    expect(pages).toBe(3);
    expect(await pending("rtr-")).toEqual({ count: 0 });

    expect(await tagNames(unicode)).toEqual(["日本語", "rtrascii"]);
    expect(await timelineIds("日本語")).toEqual([unicode]);
    expect(await timelineIds("rtrascii")).toEqual([unicode]);
    expect(await timelineIds("rtrmany", 40)).toHaveLength(40);
    expect(await searchNames("rtrmany")).toEqual(["rtrmany"]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM remote_status_tags WHERE tag = 'rtrmany'",
      ).first(),
    ).toEqual({ count: 250 });
    // An ASCII-only status is not sent back: it keeps what it had.
    expect(await tagNames(ascii)).toEqual([]);
    expect(await timelineIds("rtrplain")).toEqual([]);

    // With nothing left, the cron's job reads one empty page.
    expect(await processOutboxJob(env, { kind: "BackfillRemoteTags" })).toBe("ok");
  });

  it("leaves a status alone when a delivery wrote its own tags after the pass read it", async () => {
    const author = await remoteActor("rtr-race");
    const object = {
      id: "https://remote.example/notes/rtr-race",
      type: "Note",
      attributedTo: author.actorUri,
      content: `<p>${hashtagHtml("rtrracehtml")}</p>`,
      tag: [{ type: "Hashtag", name: "#rtrraceap" }],
      published: "2026-10-20T00:00:00.000Z",
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    };
    // Stored before tags were read from `tag`, and sent back by the migration.
    const id = await stored(author, "rtr-race", object.content);
    await env.DB.prepare("UPDATE remote_statuses SET tags_indexed = 0 WHERE id = ?").bind(id).run();

    // The pass reads the status as pending; its author's Update lands before the pass writes.
    const page = await indexMissingRemoteTags(
      beforeBatch(env.DB, async () => {
        expect(await author.send({ id: `${object.id}/update`, type: "Update", object })).toBe(202);
        expect(await tagNames(id)).toEqual(["rtrraceap"]);
      }),
    );

    expect(page.isOk() && page.value.scanned).toBe(1);
    expect(await tagNames(id)).toEqual(["rtrraceap"]);
    expect(await timelineIds("rtrracehtml")).toEqual([]);
    expect(await searchNames("rtrrace")).toEqual(["rtrraceap"]);
  });

  it("queues another pass after a full one, and none after a short one", async () => {
    const author = await remoteActor("rtr-chain");
    const first = await stored(author, "rtr-chain", "<p>#rtrchain</p>");
    // 150 pending in all: a full pass of 100, then a short one.
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 149)
       INSERT INTO remote_statuses
         (id, actor_uri, object_uri, content_html, visibility, published_at, tags_indexed)
       SELECT CAST(CAST(s.id AS INTEGER) - 1000 - i AS TEXT), s.actor_uri,
              printf('https://remote.example/notes/rtr-chain-%03d', i),
              s.content_html, s.visibility, s.published_at, 0
       FROM n, (SELECT * FROM remote_statuses WHERE id = ?) s`,
    )
      .bind(first)
      .run();
    await env.DB.prepare("UPDATE remote_statuses SET tags_indexed = 0 WHERE id = ?")
      .bind(first)
      .run();
    const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);

    expect(await processOutboxJob(env, { kind: "BackfillRemoteTags" })).toBe("ok");
    expect(send.mock.calls).toEqual([[{ kind: "BackfillRemoteTags" }]]);
    expect(await pending("rtr-chain")).toEqual({ count: 50 });

    expect(await processOutboxJob(env, { kind: "BackfillRemoteTags" })).toBe("ok");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await pending("rtr-chain")).toEqual({ count: 0 });
  });
});
