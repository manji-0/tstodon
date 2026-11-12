import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import migration from "../app/db/migrations/0136_remote_tag_reindex.sql?raw";
import { parseRows } from "./d1";
import {
  deleteUnindexedRemoteStatusTags,
  insertUnindexedRemoteStatusTags,
} from "./generated/prisma/sql";
import { processOutboxJob } from "./outbox-job";
import { indexMissingRemoteTags } from "./remote-status-store";
import { d1PrepareTyped } from "./typed-sql";

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

  it("leaves a status alone once a delivery wrote its own tags", async () => {
    const author = await remoteActor("rtr-race");
    const id = await stored(author, "rtr-race", `<p>${hashtagHtml("rtrracehtml")}</p>`);
    expect(await tagNames(id)).toEqual([]);

    // The page was read while the row was pending; the delivery landed since.
    await env.DB.batch([
      d1PrepareTyped(env.DB, deleteUnindexedRemoteStatusTags(JSON.stringify([id]))),
      d1PrepareTyped(
        env.DB,
        insertUnindexedRemoteStatusTags(JSON.stringify([[id, ["rtrracehtml"]]])),
      ),
    ]);
    expect(await tagNames(id)).toEqual([]);
  });
});
