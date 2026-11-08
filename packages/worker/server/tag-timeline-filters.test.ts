import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

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

const StatusSchema = z.object({ id: z.string().min(1) });

const postStatus = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body).id;
};

/** Upload one tiny PNG and return its media id. */
const uploadMedia = async (email: string): Promise<string> => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);
  const form = new FormData();
  form.set("file", new File([png], "dot.png", { type: "image/png" }));
  const response = await json("/api/v2/media", {
    method: "POST",
    headers: await auth(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body).id;
};

const tagTimeline = async (path: string): Promise<string[]> => {
  const response = await json(`/api/v1/timelines/tag/${path}`);
  expect(response.status).toBe(200);
  return read(z.array(StatusSchema), response.body).map((status) => status.id);
};

describe("tag timeline additional tags", () => {
  it("filters with any[]", async () => {
    const author = "tag-any@example.com";
    await postStatus(author, { status: "first #tagany #alpha" });
    await postStatus(author, { status: "second #tagany #beta" });
    const both = await postStatus(author, { status: "third #tagany #alpha #beta" });

    const any = await tagTimeline("tagany?any[]=beta");
    expect(any).toContain(both);
    expect(any).toHaveLength(2);
    // The bare `name` form and a leading `#` are accepted too.
    expect(await tagTimeline("tagany?any=%23beta")).toEqual(any);
  });

  it("filters with all[]", async () => {
    const author = "tag-all@example.com";
    await postStatus(author, { status: "first #tagall #alpha" });
    const both = await postStatus(author, { status: "second #tagall #alpha #beta" });

    expect(await tagTimeline("tagall?all[]=alpha&all[]=beta")).toEqual([both]);
  });

  it("filters with none[]", async () => {
    const author = "tag-none@example.com";
    const only = await postStatus(author, { status: "first #tagnone #alpha" });
    await postStatus(author, { status: "second #tagnone #beta" });

    expect(await tagTimeline("tagnone?none[]=beta")).toEqual([only]);
  });

  it("applies at most four additional tags", async () => {
    const author = "tag-cap@example.com";
    // The status carries four of the five requested tags; the fifth is ignored.
    const posted = await postStatus(author, {
      status: "capped #tagcap #one #two #three #four",
    });
    const path = "tagcap?all[]=one&all[]=two&all[]=three&all[]=four&all[]=five";
    expect(await tagTimeline(path)).toEqual([posted]);
  });

  it("filters with only_media", async () => {
    const author = "tag-media@example.com";
    const mediaId = await uploadMedia(author);
    await postStatus(author, { status: "text only #tagmedia" });
    const withMedia = await postStatus(author, {
      status: "with a file #tagmedia",
      media_ids: [mediaId],
    });

    expect(await tagTimeline("tagmedia?only_media=true")).toEqual([withMedia]);
    expect(await tagTimeline("tagmedia")).toHaveLength(2);
  });
});
