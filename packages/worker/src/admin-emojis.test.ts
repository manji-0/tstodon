import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

const auth = (email: string, admin = false): Promise<Record<string, string>> =>
  authHeaders(email, { admin });

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

const AdminEmojiSchema = z.object({
  id: z.string().min(1),
  shortcode: z.string().min(1),
  url: z.string().min(1),
  static_url: z.string().min(1),
  visible_in_picker: z.boolean(),
});

const PublicEmojiSchema = z.object({
  shortcode: z.string().min(1),
  url: z.string().min(1),
});

const upload = async (
  email: string,
  shortcode: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> => {
  const form = new FormData();
  form.set("shortcode", shortcode);
  for (const [key, value] of Object.entries(extra)) {
    form.set(key, value);
  }
  form.set(
    "image",
    new File([new Uint8Array([137, 80, 78, 71])], "emoji.png", { type: "image/png" }),
  );
  return json("/api/v1/admin/custom_emojis", {
    method: "POST",
    headers: await auth(email, true),
    body: form,
  });
};

describe("admin custom emojis", () => {
  it("rejects non-admins", async () => {
    expect((await json("/api/v1/admin/custom_emojis")).status).toBe(401);
    expect(
      (
        await json("/api/v1/admin/custom_emojis", {
          headers: await auth("emoji-plain@example.com"),
        })
      ).status,
    ).toBe(403);
  });

  it("creates, exposes, updates, and deletes an emoji", async () => {
    const email = "emoji-admin@example.com";
    const created = await upload(email, "admintest", { category: "Testing" });
    expect(created.status).toBe(200);
    const emoji = read(AdminEmojiSchema, created.body);
    expect(emoji.shortcode).toBe("admintest");
    expect(emoji.visible_in_picker).toBe(true);
    expect(emoji.url).toContain(`emoji/${emoji.id}`);

    const list = await json("/api/v1/admin/custom_emojis", { headers: await auth(email, true) });
    expect(list.status).toBe(200);
    expect(read(z.array(AdminEmojiSchema), list.body).map((entry) => entry.id)).toContain(emoji.id);

    const publicList = await json("/api/v1/custom_emojis");
    expect(publicList.status).toBe(200);
    expect(
      read(z.array(PublicEmojiSchema), publicList.body).map((entry) => entry.shortcode),
    ).toContain("admintest");

    const status = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("emoji-admin@example.com")) },
      body: JSON.stringify({ status: "hi :admintest:" }),
    });
    expect(status.status).toBe(200);
    expect(
      read(z.object({ emojis: z.array(PublicEmojiSchema) }), status.body).emojis.map(
        (entry) => entry.shortcode,
      ),
    ).toContain("admintest");

    const updated = await json(`/api/v1/admin/custom_emojis/${emoji.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await auth(email, true)) },
      body: JSON.stringify({ visible_in_picker: false }),
    });
    expect(updated.status).toBe(200);
    expect(read(AdminEmojiSchema, updated.body).visible_in_picker).toBe(false);

    const removed = await json(`/api/v1/admin/custom_emojis/${emoji.id}`, {
      method: "DELETE",
      headers: await auth(email, true),
    });
    expect(removed.status).toBe(200);
    const after = await json("/api/v1/admin/custom_emojis", { headers: await auth(email, true) });
    expect(read(z.array(AdminEmojiSchema), after.body).map((entry) => entry.id)).not.toContain(
      emoji.id,
    );
  });

  it("rejects a duplicate or config-reserved shortcode", async () => {
    const email = "emoji-dupe@example.com";
    expect((await upload(email, "dupewave")).status).toBe(200);
    expect((await upload(email, "dupewave")).status).toBe(422);
    expect((await upload(email, "tstodon")).status).toBe(422);
    expect((await upload(email, "bad shortcode")).status).toBe(422);
  });

  it("404s when deleting an unknown emoji", async () => {
    const response = await json("/api/v1/admin/custom_emojis/does-not-exist", {
      method: "DELETE",
      headers: await auth("emoji-missing@example.com", true),
    });
    expect(response.status).toBe(404);
  });
});
