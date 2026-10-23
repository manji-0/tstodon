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

const AttachmentSchema = z.object({
  id: z.string().min(1),
  description: z.string().nullable(),
  meta: z.object({ focus: z.object({ x: z.number(), y: z.number() }).optional() }),
});

const upload = async (email: string): Promise<string> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([9, 9, 9])], "a.png", { type: "image/png" }));
  const response = await json("/api/v2/media", {
    method: "POST",
    headers: await auth(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const attachmentsOf = (body: unknown): z.infer<typeof AttachmentSchema>[] =>
  read(z.object({ media_attachments: z.array(AttachmentSchema) }), body).media_attachments;

describe("media attributes", () => {
  it("accepts a JSON media_attributes array at create", async () => {
    const email = "attr-json@example.com";
    const mediaId = await upload(email);

    const response = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({
        status: "tagged media",
        media_ids: [mediaId],
        media_attributes: [{ id: mediaId, description: "a described image", focus: "0.5,-0.5" }],
      }),
    });
    expect(response.status).toBe(200);
    const attachment = attachmentsOf(response.body)[0];
    expect(attachment?.description).toBe("a described image");
    expect(attachment?.meta.focus).toEqual({ x: 0.5, y: -0.5 });
  });

  it("accepts bracket-form media_attributes at create", async () => {
    const email = "attr-form@example.com";
    const mediaId = await upload(email);

    const form = new URLSearchParams({
      status: "form media",
      media_ids: mediaId,
      "media_attributes[0][id]": mediaId,
      "media_attributes[0][description]": "alt from a form",
      "media_attributes[0][focus]": "0,0.25",
    });
    const response = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(await auth(email)) },
      body: form.toString(),
    });
    expect(response.status).toBe(200);
    const attachment = attachmentsOf(response.body)[0];
    expect(attachment?.description).toBe("alt from a form");
    expect(attachment?.meta.focus).toEqual({ x: 0, y: 0.25 });
  });

  it("applies attributes on edit and ignores foreign media", async () => {
    const email = "attr-edit@example.com";
    const mediaId = await upload(email);
    const otherId = await upload("attr-other@example.com");

    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "before edit", media_ids: [mediaId] }),
    });
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;

    const edited = await json(`/api/v1/statuses/${statusId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({
        media_attributes: [
          { id: mediaId, description: "described on edit" },
          { id: otherId, description: "should be ignored" },
        ],
      }),
    });
    expect(edited.status).toBe(200);
    const attachments = attachmentsOf(edited.body);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.description).toBe("described on edit");

    const foreign = await json(`/api/v1/media/${otherId}`, {
      method: "PUT",
      headers: await auth("attr-other@example.com"),
      body: new FormData(),
    });
    expect(foreign.status).toBe(200);
    expect(read(AttachmentSchema, foreign.body).description).toBeNull();
  });
});
