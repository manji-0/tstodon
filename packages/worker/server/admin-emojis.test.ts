import { SELF, env } from "cloudflare:test";
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
  image: File = new File([new Uint8Array([137, 80, 78, 71])], "emoji.png", { type: "image/png" }),
): Promise<{ status: number; body: unknown }> => {
  const form = new FormData();
  form.set("shortcode", shortcode);
  for (const [key, value] of Object.entries(extra)) {
    form.set(key, value);
  }
  form.set("image", image);
  return json("/api/v1/admin/custom_emojis", {
    method: "POST",
    headers: await auth(email, true),
    body: form,
  });
};

describe("admin custom emojis", () => {
  it("serves the emoji's image at its URL when the Worker serves the media", async () => {
    const emoji = read(
      AdminEmojiSchema,
      (await upload("emoji-served@example.com", "servedtest")).body,
    );
    const path = new URL(emoji.url).pathname;
    expect(path).toBe(`/emoji/${emoji.id}`);

    const served = await SELF.fetch(`https://example.com${path}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    // A replaced image is deleted, so it is not cached for good.
    expect(served.headers.get("cache-control")).toBe("public, max-age=3600");
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([137, 80, 78, 71]);

    const missing = await SELF.fetch("https://example.com/emoji/1");
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
  });

  // The Worker serves an emoji from its own origin, where a script would run
  // with the instance's cookies.
  it("takes a PNG, GIF or WebP image only, and never serves another type as itself", async () => {
    const email = "emoji-types@example.com";
    const script = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>";
    for (const [name, type] of [
      ["emoji.svg", "image/svg+xml"],
      ["emoji.html", "text/html"],
      ["emoji", ""],
    ] as const) {
      const refused = await upload(email, "typestest", {}, new File([script], name, { type }));
      expect(refused.status, type).toBe(422);
    }
    for (const type of ["image/gif", "image/webp"]) {
      const taken = await upload(
        email,
        `types${type.slice(6)}`,
        {},
        new File([new Uint8Array([1, 2, 3])], "emoji", { type }),
      );
      expect(taken.status, type).toBe(200);
    }

    const emoji = read(AdminEmojiSchema, (await upload(email, "typestest")).body);
    const path = new URL(emoji.url).pathname;
    const replacement = new FormData();
    replacement.set("image", new File([script], "emoji.svg", { type: "image/svg+xml" }));
    const replaced = await SELF.fetch(
      `https://example.com/api/v1/admin/custom_emojis/${emoji.id}`,
      {
        method: "PATCH",
        headers: await auth(email, true),
        body: replacement,
      },
    );
    expect(replaced.status).toBe(422);
    await replaced.arrayBuffer();
    const served = await SELF.fetch(`https://example.com${path}`);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([137, 80, 78, 71]);

    // An object stored before the upload checked its type.
    await env.MEDIA.put("emoji/7", script, { httpMetadata: { contentType: "image/svg+xml" } });
    const old = await SELF.fetch("https://example.com/emoji/7");
    expect(old.status).toBe(200);
    expect(old.headers.get("content-type")).toBe("application/octet-stream");
    expect(old.headers.get("x-content-type-options")).toBe("nosniff");
    await old.arrayBuffer();
  });

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
