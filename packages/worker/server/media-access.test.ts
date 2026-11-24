import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { PNG_40X30 } from "../test/image-fixtures";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { signUp } from "../test/passkey-browser";
import { purgeAccount } from "./admin-actions";

const BYTES = [...PNG_40X30];

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const fetchPath = (path: string, init?: RequestInit): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, { redirect: "manual", ...init });

const accountIdOf = async (email: string): Promise<string> => {
  const response = await fetchPath("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  return read(z.object({ id: z.string().min(1) }), await response.json()).id;
};

const AttachmentSchema = z.object({ id: z.string().min(1), url: z.string().min(1) });

const upload = async (email: string): Promise<z.infer<typeof AttachmentSchema>> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(BYTES)], "a.png", { type: "image/png" }));
  const response = await fetchPath("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(AttachmentSchema, await response.json());
};

const post = async (
  email: string,
  mediaId: string,
  visibility: string,
): Promise<z.infer<typeof AttachmentSchema>> => {
  const response = await fetchPath("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: "a picture", media_ids: [mediaId], visibility }),
  });
  expect(response.status).toBe(200);
  const attachment = read(
    z.object({ media_attachments: z.array(AttachmentSchema) }),
    await response.json(),
  ).media_attachments[0];
  if (!attachment) {
    throw new Error("status has no attachment");
  }
  return attachment;
};

const bytesAt = async (url: string): Promise<number[]> => {
  const response = await SELF.fetch(url);
  expect(response.status).toBe(200);
  return [...new Uint8Array(await response.arrayBuffer())];
};

describe("media access", () => {
  it("does not serve a direct post's attachment to someone who knows only its account and id", async () => {
    const email = "media-direct@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const attached = await post(email, media.id, "direct");

    // The id's instant bounds a guess; the stored object must not sit at the guessed key.
    expect((await fetchPath(`/attachments/${accountId}/${media.id}`)).status).toBe(404);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);

    const lastSegment = new URL(attached.url).pathname.split("/").at(-1) ?? "";
    expect(lastSegment).toMatch(/^[0-9a-f]{32}$/);
    expect(await bytesAt(attached.url)).toEqual(BYTES);
  });

  it("gives every upload its own random key", async () => {
    const email = "media-keys@example.com";
    const first = await upload(email);
    const second = await upload(email);
    expect(first.url).not.toBe(second.url);
    expect(first.url).not.toContain(first.id);
  });

  it("redirects /media/:id to the file only for media on a status the viewer may see", async () => {
    const email = "media-public@example.com";
    const media = await upload(email);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);

    const attached = await post(email, media.id, "public");
    const response = await fetchPath(`/media/${media.id}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(attached.url);

    const privateMedia = await upload(email);
    await post(email, privateMedia.id, "private");
    expect((await fetchPath(`/media/${privateMedia.id}`)).status).toBe(404);
  });

  it("redirects the author's own browser session to media on a private post", async () => {
    const { fetcher } = await signUp("media_owner");
    const email = "media_owner@mail.example";
    const media = await upload(email);
    const attached = await post(email, media.id, "private");

    const response = await fetcher(`/media/${media.id}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(attached.url);
    expect((await fetchPath(`/media/${media.id}`)).status).toBe(404);
  });
});

const storedKey = async (id: string): Promise<string> =>
  read(
    z.object({ object_key: z.string() }),
    await env.DB.prepare("SELECT object_key FROM media_attachments WHERE id = ?").bind(id).first(),
  ).object_key;

describe("purging an account", () => {
  it("purges objects under the account's prefix that no row names", async () => {
    const email = "media-purge@example.com";
    const accountId = await accountIdOf(email);
    const media = await upload(email);
    const rowKey = await storedKey(media.id);
    const orphan = `attachments/${accountId}/${"0".repeat(32)}`;
    await env.MEDIA.put(orphan, new Uint8Array(BYTES));

    expect((await purgeAccount(env, accountId)).isOk()).toBe(true);

    expect(await env.MEDIA.head(rowKey)).toBeNull();
    expect(await env.MEDIA.head(orphan)).toBeNull();
  });
});
