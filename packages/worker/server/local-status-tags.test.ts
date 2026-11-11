import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { openStream } from "../test/stream-fixture";
import { parseRows } from "./d1";

const ORIGIN = "https://example.com";

const send = async (
  email: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(200);
  return response.json();
};

const post = async (email: string, status: string): Promise<string> => {
  const parsed = schemaResult(ApiStatus)(await send(email, "POST", "/api/v1/statuses", { status }));
  if (parsed.isErr()) {
    throw new Error("status rejected");
  }
  return parsed.value.id;
};

const ids = async (email: string, path: string): Promise<string[]> => {
  const parsed = schemaResult(z.array(ApiStatus))(await send(email, "GET", path));
  if (parsed.isErr()) {
    throw new Error("timeline rejected");
  }
  return parsed.value.map((status) => status.id);
};

const indexedTags = async (statusId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT tag FROM local_status_tags WHERE status_id = ? ORDER BY tag",
  )
    .bind(statusId)
    .all();
  return parseRows(z.object({ tag: z.string() }), results).map((row) => row.tag);
};

describe("a local status's tags, matched as extractHashtags reads them", () => {
  it("list a tag's own posts only, on the tag timeline and an account's tagged filter", async () => {
    const email = "lst-rule@example.com";
    const account = await signedInAccount(email);
    const longer = await post(email, "a longer tag #lstcategory");
    const bracketed = await post(email, "not a tag (#lstcat)");
    const wide = await post(email, "a full-width tag ＃ＬＳＴＣＡＴ");
    const plain = await post(email, "a plain tag #LstCat");

    expect(await ids(email, "/api/v1/timelines/tag/lstcat")).toEqual([plain, wide]);
    expect(await ids(email, `/api/v1/accounts/${account.id}/statuses?tagged=lstcat`)).toEqual([
      plain,
      wide,
    ]);
    expect(await ids(email, "/api/v1/timelines/tag/lstcategory")).toEqual([longer]);
    expect(await indexedTags(bracketed)).toEqual([]);
  });

  it("take any, all and none from the same index", async () => {
    const email = "lst-filters@example.com";
    const both = await post(email, "#lstfa and #lstfb");
    const first = await post(email, "#lstfa alone, beside #lstfbx");
    const third = await post(email, "#lstfa with #lstfc");
    await post(email, "#lstfb alone");

    expect(await ids(email, "/api/v1/timelines/tag/lstfa?all[]=lstfb")).toEqual([both]);
    expect(await ids(email, "/api/v1/timelines/tag/lstfa?none[]=lstfb")).toEqual([third, first]);
    // As before the index, `any[]` narrows the primary tag's posts.
    expect(await ids(email, "/api/v1/timelines/tag/lstfa?any[]=lstfb&any[]=lstfc")).toEqual([
      third,
      both,
    ]);
  });

  it("follow an edit, and go with the status", async () => {
    const email = "lst-edit@example.com";
    const id = await post(email, "before the edit ＃ＬＳＴＥＤＩＴ");
    expect(await ids(email, "/api/v1/timelines/tag/lstedit")).toEqual([id]);

    await send(email, "PUT", `/api/v1/statuses/${id}`, { status: "after the edit #lstedited" });
    expect(await ids(email, "/api/v1/timelines/tag/lstedit")).toEqual([]);
    expect(await ids(email, "/api/v1/timelines/tag/lstedited")).toEqual([id]);

    await send(email, "DELETE", `/api/v1/statuses/${id}`);
    expect(await ids(email, "/api/v1/timelines/tag/lstedited")).toEqual([]);
    expect(await indexedTags(id)).toEqual([]);
  });

  it("reach a hashtag stream's subscribers", async () => {
    const author = "lst-stream-author@example.com";
    const viewer = await openStream({ email: "lst-stream-viewer@example.com" });
    await viewer.subscribe({ stream: "hashtag", tag: "lststream" });

    await post(author, "a longer tag #lststreamer");
    const wide = await post(author, "a full-width tag ＃ＬＳＴＳＴＲＥＡＭ");

    const heard = await viewer.next();
    expect(heard).toMatchObject({ stream: ["hashtag", "lststream"], event: "update" });
    const status = schemaResult(ApiStatus)(JSON.parse(heard.payload));
    expect(status.isOk() && status.value.id).toBe(wide);
    viewer.close();
  });
});
