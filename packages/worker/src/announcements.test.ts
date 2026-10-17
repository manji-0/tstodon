import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

const AnnouncementSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  read: z.boolean(),
  reactions: z.array(
    z.object({
      name: z.string().min(1),
      count: z.number(),
      me: z.boolean(),
    }),
  ),
});

const announcementOf = async (email: string): Promise<z.infer<typeof AnnouncementSchema>> => {
  const response = await json("/api/v1/announcements", { headers: await auth(email) });
  expect(response.status).toBe(200);
  const list = read(z.array(AnnouncementSchema), response.body);
  const first = list[0];
  if (!first) {
    throw new Error("expected the configured announcement");
  }
  return first;
};

const post = async (path: string, email: string): Promise<{ status: number; body: unknown }> =>
  json(path, { method: "POST", headers: await auth(email) });

describe("announcements", () => {
  it("requires authentication", async () => {
    expect((await json("/api/v1/announcements")).status).toBe(401);
  });

  it("serves the configured announcement with unread state", async () => {
    const announcement = await announcementOf("announce-reader@example.com");
    expect(announcement.id).toBe("1");
    expect(announcement.content).toContain("Welcome");
    expect(announcement.read).toBe(false);
    expect(announcement.reactions).toContainEqual({ name: "🎉", count: 0, me: false });
  });

  it("dismisses an announcement", async () => {
    const email = "announce-dismiss@example.com";
    const dismissed = await post("/api/v1/announcements/1/dismiss", email);
    expect(dismissed.status).toBe(200);
    expect((await announcementOf(email)).read).toBe(true);
  });

  it("adds and removes a reaction", async () => {
    const email = "announce-reaction@example.com";
    const added = await json("/api/v1/announcements/1/reactions/%F0%9F%8E%89", {
      method: "PUT",
      headers: await auth(email),
    });
    expect(added.status).toBe(200);
    const reacted = await announcementOf(email);
    expect(reacted.reactions).toContainEqual({ name: "🎉", count: 1, me: true });

    const removed = await json("/api/v1/announcements/1/reactions/%F0%9F%8E%89", {
      method: "DELETE",
      headers: await auth(email),
    });
    expect(removed.status).toBe(200);
    expect((await announcementOf(email)).reactions).toContainEqual({
      name: "🎉",
      count: 0,
      me: false,
    });
  });

  it("rejects reactions that are neither declared nor a custom emoji", async () => {
    const response = await json("/api/v1/announcements/1/reactions/nope", {
      method: "PUT",
      headers: await auth("announce-invalid@example.com"),
    });
    expect(response.status).toBe(422);
  });

  it("404s for an unknown announcement", async () => {
    const response = await post(
      "/api/v1/announcements/does-not-exist/dismiss",
      "announce-missing@example.com",
    );
    expect(response.status).toBe(404);
  });
});
