import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { processOutboxJob } from "./outbox-job";
import { foldTagNames } from "./tag-name-fold";

const author = "tag-name-fold@example.com";
const other = "tag-name-fold-other@example.com";

const post = async (status: string): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(author)) },
    body: JSON.stringify({ status }),
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(z.object({ id: z.string() }))(await response.json());
  return parsed.isOk() ? parsed.value.id : "unreadable";
};

const timeline = async (tag: string): Promise<string[]> => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/timelines/tag/${encodeURIComponent(tag)}`,
  );
  expect(response.status).toBe(200);
  const parsed = schemaResult(z.array(z.object({ id: z.string() })))(await response.json());
  return parsed.isOk() ? parsed.value.map((status) => status.id).sort() : ["unreadable"];
};

const followedTags = async (email: string): Promise<string[]> => {
  const response = await SELF.fetch("https://example.com/api/v1/followed_tags", {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  const parsed = schemaResult(z.array(z.object({ name: z.string() })))(await response.json());
  return parsed.isOk() ? parsed.value.map((tag) => tag.name).sort() : ["unreadable"];
};

const rows = async (sql: string): Promise<unknown[][]> => {
  const { results } = await env.DB.prepare(sql).all();
  return parseRows(z.record(z.string(), z.unknown()), results).map((row) => Object.values(row));
};

/** Every stored tag name of this file's tests (`tnf...`), by table. */
const stored = async (): Promise<Record<string, unknown[][]>> => ({
  tags: await rows(
    "SELECT name, usable, listable, display_name FROM tags WHERE name LIKE 'tnf%' ORDER BY name",
  ),
  followed: await rows(
    "SELECT account_id, tag_name FROM followed_tags WHERE tag_name LIKE 'tnf%' ORDER BY 2, 1",
  ),
  featured: await rows(
    "SELECT account_id, tag_name FROM featured_tags WHERE tag_name LIKE 'tnf%' ORDER BY 2, 1",
  ),
  local: await rows(
    "SELECT status_id, tag FROM local_status_tags WHERE tag LIKE 'tnf%' ORDER BY 2, 1",
  ),
  remote: await rows(
    "SELECT status_id, tag FROM remote_status_tags WHERE tag LIKE 'tnf%' ORDER BY 2, 1",
  ),
  reviews: await rows(
    "SELECT target, state FROM trend_reviews WHERE kind = 'Tag' AND target LIKE 'tnf%' ORDER BY 1",
  ),
  streams: await rows(
    "SELECT hub, stream, param FROM stream_subscriptions WHERE param LIKE 'tnf%' ORDER BY 1, 2, 3",
  ),
});

const restartCursor = async (): Promise<void> => {
  await env.DB.prepare(
    "UPDATE backfill_cursors SET after_id = '', completed_at = NULL WHERE name = 'tag_name_fold'",
  ).run();
};

const foldEveryPage = async (pageSize: number): Promise<number> => {
  let pages = 0;
  for (;;) {
    pages += 1;
    const page = await foldTagNames(env.DB, pageSize);
    expect(page.isErr() ? page.error.message : "").toBe("");
    if (page.isErr() || !page.value.chained) {
      return pages;
    }
  }
};

describe("accent folding of tag names", () => {
  it("lists a post tagged #café and one tagged #cafe under one tag", async () => {
    const accented = await post("un #AcfCafé");
    const plain = await post("a #acfcafe");
    const both = [accented, plain].sort();

    expect(await timeline("acfcafe")).toEqual(both);
    expect(await timeline("acfcafé")).toEqual(both);
    expect(await timeline("ACFCAFÉ")).toEqual(both);
  });

  it("renames the names stored before the fold and merges them with the folded ones", async () => {
    const first = (await signedInAccount(author)).id;
    const second = (await signedInAccount(other)).id;
    const onlyOld = await post("stored under the old name");
    const onlyNew = await post("stored under the #tnfmerge name");
    const underBoth = await post("stored under both names");
    const actor = await remoteActor("tnf", "tnf.example");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at)
         VALUES ('tnf-remote', ?, ?, '<p>remote</p>', 'public', '2026-01-01T00:00:00.000Z')`,
      ).bind(actor.actorUri, `${actor.actorUri}/statuses/1`),
      env.DB.prepare(
        `INSERT INTO local_status_tags (status_id, tag) VALUES
         (?1, 'tnfmergé'), (?2, 'tnfmergé'), (?2, 'tnfmerge'), (?1, 'tnf日本')`,
      ).bind(onlyOld, underBoth),
      env.DB.prepare(
        "INSERT INTO remote_status_tags (status_id, tag) VALUES ('tnf-remote', 'tnfmergé')",
      ),
      env.DB.prepare(
        `INSERT INTO followed_tags (account_id, tag_name) VALUES
         (?1, 'tnfmergé'), (?2, 'tnfmerge'), (?2, 'tnfmergè')`,
      ).bind(first, second),
      env.DB.prepare(
        `INSERT INTO featured_tags (account_id, tag_name) VALUES
         (?1, 'tnfmergé'), (?1, 'tnfmerge'), (?2, 'tnfmergé')`,
      ).bind(first, second),
      // `tnfmodé` is unusable and `tnfmode` unlisted: the merged tag is both.
      env.DB.prepare(
        `INSERT OR REPLACE INTO tags (name, usable, listable, display_name) VALUES
         ('tnfmergé', 1, 1, NULL), ('tnfmergè', 1, 1, NULL),
         ('tnfmodé', 0, 1, 'TnfModé'), ('tnfmode', 1, 0, NULL),
         ('tnfkeepé', 1, 1, 'TNFKEEPÉ'), ('tnfkeepe', 1, 1, 'TnfKeepE'),
         ('tnf日本', 1, 1, NULL)`,
      ),
      env.DB.prepare(
        `INSERT INTO trend_reviews (kind, target, state, reviewed_at) VALUES
         ('Tag', 'tnfmodé', 'Rejected', '2026-01-02T00:00:00.000Z'),
         ('Tag', 'tnfmode', 'Approved', '2026-01-01T00:00:00.000Z'),
         ('Tag', 'tnfkeepé', 'Approved', '2026-01-02T00:00:00.000Z'),
         ('Tag', 'tnfkeepe', 'Rejected', '2026-01-01T00:00:00.000Z'),
         ('Link', 'https://tnf.example/é', 'Rejected', '2026-01-01T00:00:00.000Z')`,
      ),
      // No post uses this tag: a fan-out drops the row of a hub without sockets.
      env.DB.prepare(
        `INSERT INTO stream_subscriptions (hub, stream, param) VALUES
         ('tnf-hub-1', 'hashtag', 'tnfstreamé'), ('tnf-hub-1', 'hashtag', 'tnfstreame'),
         ('tnf-hub-2', 'hashtag:local', 'tnfstreamé'), ('tnf-hub-3', 'list', 'tnflisté')`,
      ),
    ]);
    await restartCursor();
    expect(await timeline("tnfmergé")).toEqual([onlyNew, underBoth].sort());

    expect(await foldEveryPage(2)).toBeGreaterThan(1);

    const merged = {
      tags: [
        ["tnfkeepe", 1, 1, "TnfKeepE"],
        ["tnfmerge", 1, 1, null],
        ["tnfmode", 0, 0, "TnfModé"],
        ["tnf日本", 1, 1, null],
      ],
      followed: [
        [first, "tnfmerge"],
        [second, "tnfmerge"],
      ].sort(),
      featured: [
        [first, "tnfmerge"],
        [second, "tnfmerge"],
      ].sort(),
      local: [
        ...[onlyOld, onlyNew, underBoth].sort().map((id) => [id, "tnfmerge"]),
        [onlyOld, "tnf日本"],
      ],
      remote: [["tnf-remote", "tnfmerge"]],
      reviews: [
        ["tnfkeepe", "Rejected"],
        ["tnfmode", "Rejected"],
      ],
      streams: [
        ["tnf-hub-1", "hashtag", "tnfstreame"],
        ["tnf-hub-2", "hashtag:local", "tnfstreame"],
        ["tnf-hub-3", "list", "tnflisté"],
      ],
    };
    expect(await stored()).toEqual(merged);
    expect(await timeline("tnfmergé")).toEqual(["tnf-remote", onlyOld, onlyNew, underBoth].sort());
    expect(await followedTags(author)).toEqual(["tnfmerge"]);
    expect(await followedTags(other)).toEqual(["tnfmerge"]);
    expect(await rows("SELECT state FROM trend_reviews WHERE kind = 'Link'")).toEqual([
      ["Rejected"],
    ]);

    // A second pass over the same names changes nothing.
    await restartCursor();
    await foldEveryPage(2);
    expect(await stored()).toEqual(merged);

    // Once at the end, the cron's job reads the cursor and stops.
    await env.DB.prepare("INSERT INTO tags (name) VALUES ('tnflaté')").run();
    expect(await processOutboxJob(env, { kind: "FoldTagNames" })).toBe("ok");
    expect(await rows("SELECT name FROM tags WHERE name LIKE 'tnflat%'")).toEqual([["tnflaté"]]);
  });

  it("is run by the cron's job from a fresh cursor", async () => {
    await env.DB.prepare("INSERT INTO tags (name) VALUES ('tnfcroné')").run();
    await restartCursor();
    expect(await processOutboxJob(env, { kind: "FoldTagNames" })).toBe("ok");
    expect(await rows("SELECT name FROM tags WHERE name LIKE 'tnfcron%'")).toEqual([["tnfcrone"]]);
  });

  it("keeps the earlier follow date when two spellings merge", async () => {
    const id = (await signedInAccount(author)).id;
    await env.DB.prepare(
      `INSERT INTO followed_tags (account_id, tag_name, created_at) VALUES
       (?1, 'tnfdaté', '2020-01-01T00:00:00.000Z'), (?1, 'tnfdate', '2022-01-01T00:00:00.000Z')`,
    )
      .bind(id)
      .run();
    await restartCursor();
    await foldEveryPage(200);
    expect(
      await rows("SELECT tag_name, created_at FROM followed_tags WHERE tag_name LIKE 'tnfdat%'"),
    ).toEqual([["tnfdate", "2020-01-01T00:00:00.000Z"]]);
  });

  it("removes a spelling the job has not renamed yet when the tag is unfollowed", async () => {
    const id = (await signedInAccount(other)).id;
    await env.DB.prepare(
      "INSERT INTO followed_tags (account_id, tag_name) VALUES (?1, 'tnfunfollowé')",
    )
      .bind(id)
      .run();
    const response = await SELF.fetch("https://example.com/api/v1/tags/tnfunfollowe/unfollow", {
      method: "POST",
      headers: await authHeaders(other),
    });
    expect(response.status).toBe(200);
    await restartCursor();
    await foldEveryPage(200);
    expect(await followedTags(other)).not.toContain("tnfunfollowe");
  });
});
