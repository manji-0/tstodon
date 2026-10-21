import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const StatusIdSchema = z.object({ id: z.string().min(1) });

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const postStatus = async (email: string, status: string): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status }),
  });
  expect(response.status).toBe(200);
  return read(StatusIdSchema, response.body).id;
};

const idsAt = async (path: string, email?: string): Promise<string[]> => {
  const response = await json(path, email ? { headers: await auth(email) } : undefined);
  expect(response.status).toBe(200);
  return read(z.array(StatusIdSchema), response.body).map((status) => status.id);
};

const action = async (path: string, email: string): Promise<void> => {
  const response = await json(path, { method: "POST", headers: await auth(email) });
  expect(response.status).toBe(200);
};

describe("timeline pagination", () => {
  it("pages the home timeline with max_id, since_id, and min_id", async () => {
    const viewerEmail = "page-viewer@example.com";
    const authorEmail = "page-author@example.com";
    const authorId = await accountIdFor(authorEmail);
    await accountIdFor(viewerEmail);
    await action(`/api/v1/accounts/${authorId}/follow`, viewerEmail);

    const first = await postStatus(authorEmail, "page one");
    const second = await postStatus(authorEmail, "page two");
    const third = await postStatus(authorEmail, "page three");

    expect(await idsAt("/api/v1/timelines/home", viewerEmail)).toEqual([third, second, first]);
    expect(await idsAt(`/api/v1/timelines/home?max_id=${second}`, viewerEmail)).toEqual([first]);
    expect(await idsAt(`/api/v1/timelines/home?since_id=${first}`, viewerEmail)).toEqual([
      third,
      second,
    ]);
    // min_id pages upward from the oldest side.
    expect(await idsAt(`/api/v1/timelines/home?min_id=${first}&limit=2`, viewerEmail)).toEqual([
      second,
      third,
    ]);
  });

  it("pages bookmarks and favourites", async () => {
    const email = "page-owner@example.com";
    await accountIdFor(email);
    const first = await postStatus(email, "saved one");
    const second = await postStatus(email, "saved two");
    await action(`/api/v1/statuses/${first}/bookmark`, email);
    await action(`/api/v1/statuses/${second}/bookmark`, email);
    await action(`/api/v1/statuses/${first}/favourite`, email);
    await action(`/api/v1/statuses/${second}/favourite`, email);

    expect(await idsAt("/api/v1/bookmarks", email)).toEqual([second, first]);
    expect(await idsAt(`/api/v1/bookmarks?max_id=${second}`, email)).toEqual([first]);
    expect(await idsAt(`/api/v1/bookmarks?since_id=${first}`, email)).toEqual([second]);
    expect(await idsAt(`/api/v1/favourites?max_id=${second}`, email)).toEqual([first]);
    expect(await idsAt(`/api/v1/favourites?min_id=${first}`, email)).toEqual([second]);

    const accountId = await accountIdFor(email);
    expect(await idsAt(`/api/v1/accounts/${accountId}/statuses?min_id=${first}`)).toEqual([second]);
    expect(await idsAt(`/api/v1/accounts/${accountId}/statuses?max_id=${second}`)).toEqual([first]);
  });

  it("pages a tag timeline", async () => {
    const email = "page-tagger@example.com";
    await accountIdFor(email);
    const first = await postStatus(email, "tag one #pagewave");
    const second = await postStatus(email, "tag two #pagewave");

    expect(await idsAt("/api/v1/timelines/tag/pagewave")).toEqual([second, first]);
    expect(await idsAt(`/api/v1/timelines/tag/pagewave?max_id=${second}`)).toEqual([first]);
    expect(await idsAt(`/api/v1/timelines/tag/pagewave?min_id=${first}`)).toEqual([second]);
  });
});
