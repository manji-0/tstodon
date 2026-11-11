import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { backfillLocalNoteTags } from "./local-tag-backfill";
import { processOutboxJob } from "./outbox-job";

const author = "local-tag-backfill@example.com";

const post = async (status: string, visibility: string): Promise<void> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(author)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
};

const names = async (query: string): Promise<string[]> => {
  const response = await SELF.fetch(`https://example.com/api/v2/search?q=${query}&type=hashtags`);
  expect(response.status).toBe(200);
  const parsed = schemaResult(z.object({ hashtags: z.array(z.object({ name: z.string() })) }))(
    await response.json(),
  );
  return parsed.isOk() ? parsed.value.hashtags.map((tag) => tag.name) : ["unreadable"];
};

const timeline = async (tag: string): Promise<string[]> => {
  const response = await SELF.fetch(`https://example.com/api/v1/timelines/tag/${tag}`);
  expect(response.status).toBe(200);
  const parsed = schemaResult(z.array(z.object({ visibility: z.string() })))(await response.json());
  return parsed.isOk() ? parsed.value.map((status) => status.visibility) : ["unreadable"];
};

/** The state a deploy leaves: notes whose names were never stored, and a fresh cursor. */
const forgetTagNames = async (prefix: string): Promise<void> => {
  await env.DB.prepare("DELETE FROM tags WHERE name >= ? AND name < ? || char(1114111)")
    .bind(prefix, prefix)
    .run();
};

describe("local note tag backfill", () => {
  it("stores the tags of stored public and unlisted notes page by page, then stops", async () => {
    await post("an old #ltbpublic note", "public");
    await post("an old #ltbunlisted note", "unlisted");
    await post("@nobody an old #ltbdirect note", "direct");
    await post("an old #ltbprivate note", "private");
    await forgetTagNames("ltb");
    await env.DB.prepare(
      "UPDATE backfill_cursors SET after_id = '', completed_at = NULL WHERE name = 'local_status_tags'",
    ).run();
    expect(await names("ltb")).toEqual([]);

    let pages = 0;
    for (;;) {
      pages += 1;
      const page = await backfillLocalNoteTags(env.DB, 2);
      expect(page.isOk()).toBe(true);
      if (page.isErr() || !page.value.chained) {
        break;
      }
    }
    expect(pages).toBeGreaterThan(1);
    expect(await names("ltb")).toEqual(["ltbpublic", "ltbunlisted"]);

    // Once at the end, the cron's job reads the cursor and stops.
    await post("a newer #ltbafter note", "public");
    await forgetTagNames("ltbafter");
    expect(await processOutboxJob(env, { kind: "BackfillLocalNoteTags" })).toBe("ok");
    expect(await names("ltbafter")).toEqual([]);
  });

  it("indexes a stored note under its tags after one page, whatever its visibility", async () => {
    await post("an old ＃ＬＴＢＩＮＤＥＸ note", "public");
    await post("an old #ltbindex followers note", "private");
    await env.DB.prepare("DELETE FROM local_status_tags WHERE tag = 'ltbindex'").run();
    await env.DB.prepare(
      "UPDATE backfill_cursors SET after_id = '', completed_at = NULL WHERE name = 'local_status_tags'",
    ).run();
    expect(await timeline("ltbindex")).toEqual([]);

    const page = await backfillLocalNoteTags(env.DB);
    expect(page.isOk() && page.value.chained).toBe(false);
    expect(await timeline("ltbindex")).toEqual(["public"]);
    const indexed = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM local_status_tags WHERE tag = 'ltbindex'",
    ).first();
    expect(indexed).toEqual({ count: 2 });
  });
});
