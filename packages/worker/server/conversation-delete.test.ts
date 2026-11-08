import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

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

const MediaSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  url: z.string().min(1),
  description: z.string().nullable(),
});

const upload = async (email: string): Promise<z.infer<typeof MediaSchema>> => {
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
  return read(MediaSchema, response.body);
};

describe("media attachment lookup", () => {
  it("serves the uploader's attachment and hides it from others", async () => {
    const owner = "media-get-owner@example.com";
    const media = await upload(owner);

    const fetched = await json(`/api/v1/media/${media.id}`, { headers: await auth(owner) });
    expect(fetched.status).toBe(200);
    expect(read(MediaSchema, fetched.body).id).toBe(media.id);

    // Another account (and an anonymous caller) cannot see it.
    expect(
      (
        await json(`/api/v1/media/${media.id}`, {
          headers: await auth("media-get-other@example.com"),
        })
      ).status,
    ).toBe(404);
    expect((await json(`/api/v1/media/${media.id}`)).status).toBe(401);
    expect(
      (await json("/api/v1/media/does-not-exist", { headers: await auth(owner) })).status,
    ).toBe(404);
  });
});

describe("conversations", () => {
  it("removes a conversation until a newer message arrives", async () => {
    const alice = "conversation-delete-alice@example.com";
    const bob = "conversation-delete-bob@example.com";
    const bobAccount = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth(bob),
    });
    const bobPreview = read(MastodonAccountPreviewSchema, bobAccount.body);
    const bobId = bobPreview.id;
    const bobUsername = bobPreview.username;

    const send = async (email: string, status: string): Promise<void> => {
      const response = await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth(email)) },
        body: JSON.stringify({ status, visibility: "direct" }),
      });
      expect(response.status).toBe(200);
    };
    await send(alice, `@${bobUsername} hello there`);

    const conversations = async (): Promise<z.infer<typeof ConversationSchema>[]> => {
      const response = await json("/api/v1/conversations", { headers: await auth(bob) });
      expect(response.status).toBe(200);
      return read(z.array(ConversationSchema), response.body);
    };
    const listed = await conversations();
    expect(listed).toHaveLength(1);
    const conversationId = listed[0]?.id ?? "";

    const removed = await json(`/api/v1/conversations/${conversationId}`, {
      method: "DELETE",
      headers: await auth(bob),
    });
    expect(removed.status).toBe(200);
    expect(await conversations()).toEqual([]);

    // Repeating the delete finds nothing to remove.
    expect(
      (
        await json(`/api/v1/conversations/${conversationId}`, {
          method: "DELETE",
          headers: await auth(bob),
        })
      ).status,
    ).toBe(404);

    // A newer message revives the thread.
    await send(alice, `@${bobUsername} again, with news`);
    expect((await conversations()).length).toBe(1);
    expect(bobId).toBeDefined();
  });
});

const ConversationSchema = z.object({
  id: z.string().min(1),
  unread: z.boolean(),
  accounts: z.array(MastodonAccountPreviewSchema),
  last_status: z.object({ id: z.string().min(1) }).nullable(),
});
