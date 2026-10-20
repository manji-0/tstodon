import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

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

const DeleteResponseSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  text: z.string(),
  media_attachments: z.array(z.object({ id: z.string().min(1) })),
  poll: z.object({ id: z.string().min(1) }).nullable(),
});

describe("delete returns a redraft source", () => {
  it("includes the raw text, media, and poll of the deleted status", async () => {
    const email = "redraft-author@example.com";

    const form = new FormData();
    form.set("file", new File([new Uint8Array([4, 4])], "a.png", { type: "image/png" }));
    const uploaded = await json("/api/v2/media", {
      method: "POST",
      headers: await auth(email),
      body: form,
    });
    const mediaId = read(z.object({ id: z.string().min(1) }), uploaded.body).id;

    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "redraft me #tag", media_ids: [mediaId] }),
    });
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;

    const deleted = await json(`/api/v1/statuses/${statusId}`, {
      method: "DELETE",
      headers: await auth(email),
    });
    expect(deleted.status).toBe(200);
    const document = read(DeleteResponseSchema, deleted.body);
    expect(document.id).toBe(statusId);
    expect(document.text).toBe("redraft me #tag");
    // The HTML rendering stays available next to the source text.
    expect(document.content).toContain("<p>");
    expect(document.media_attachments.map((attachment) => attachment.id)).toEqual([mediaId]);
    expect(document.poll).toBeNull();

    expect((await json(`/api/v1/statuses/${statusId}`)).status).toBe(404);
  });

  it("reports an empty source for a deleted reblog", async () => {
    const email = "redraft-reblog@example.com";
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "original" }),
    });
    const originalId = read(z.object({ id: z.string().min(1) }), created.body).id;
    const reblog = await json(`/api/v1/statuses/${originalId}/reblog`, {
      method: "POST",
      headers: await auth(email),
    });
    const reblogId = read(z.object({ id: z.string().min(1) }), reblog.body).id;

    const deleted = await json(`/api/v1/statuses/${reblogId}`, {
      method: "DELETE",
      headers: await auth(email),
    });
    expect(deleted.status).toBe(200);
    expect(read(DeleteResponseSchema, deleted.body).text).toBe("");
  });
});
