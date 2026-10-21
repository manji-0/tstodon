import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { schemaResult } from "@tstodon/core";
import {
  MastodonAccountPreviewSchema,
  MastodonStatusPreviewSchema,
} from "../test/mastodon-preview-schemas";

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

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const NotificationListSchema = z.array(z.object({ id: z.string().min(1), type: z.string() }));

const notificationIds = async (email: string): Promise<string[]> => {
  const response = await json("/api/v1/notifications", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(NotificationListSchema, response.body).map((item) => item.id);
};

const unreadCount = async (email: string): Promise<number> => {
  const response = await json("/api/v1/notifications/unread_count", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(z.object({ count: z.number() }), response.body).count;
};

const seedTwoNotifications = async (suffix: string): Promise<void> => {
  const authorEmail = `note-${suffix}-author@example.com`;
  const actorEmail = `note-${suffix}-actor@example.com`;
  const authorId = await accountIdFor(authorEmail);
  const status = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(authorEmail)) },
    body: JSON.stringify({ status: `note target ${suffix}` }),
  });
  expect(status.status).toBe(200);
  const statusId = read(MastodonStatusPreviewSchema, status.body).id;
  expect(
    (
      await json(`/api/v1/accounts/${authorId}/follow`, {
        method: "POST",
        headers: await auth(actorEmail),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await json(`/api/v1/statuses/${statusId}/favourite`, {
        method: "POST",
        headers: await auth(actorEmail),
      })
    ).status,
  ).toBe(200);
};

describe("notification actions", () => {
  it("requires authentication", async () => {
    expect((await json("/api/v1/notifications/unread_count")).status).toBe(401);
    expect((await json("/api/v1/notifications/clear", { method: "POST" })).status).toBe(401);
    expect((await json("/api/v1/notifications/123/dismiss", { method: "POST" })).status).toBe(401);
  });

  it("dismisses, clears, and counts notifications", async () => {
    const email = "note-clear-author@example.com";
    await seedTwoNotifications("clear");
    const ids = await notificationIds(email);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(await unreadCount(email)).toBe(ids.length);

    const victim = ids[0] ?? "";
    const dismissed = await json(`/api/v1/notifications/${victim}/dismiss`, {
      method: "POST",
      headers: await auth(email),
    });
    expect(dismissed.status).toBe(200);
    const afterDismiss = await notificationIds(email);
    expect(afterDismiss).not.toContain(victim);
    expect(await unreadCount(email)).toBe(ids.length - 1);

    const missing = await json("/api/v1/notifications/does-not-exist/dismiss", {
      method: "POST",
      headers: await auth(email),
    });
    expect(missing.status).toBe(404);

    const cleared = await json("/api/v1/notifications/clear", {
      method: "POST",
      headers: await auth(email),
    });
    expect(cleared.status).toBe(200);
    expect(await notificationIds(email)).toHaveLength(0);
    expect(await unreadCount(email)).toBe(0);
  });

  it("counts only notifications newer than the marker", async () => {
    const email = "note-marker-author@example.com";
    await seedTwoNotifications("marker");
    const ids = await notificationIds(email);
    const newest = ids[0] ?? "";
    const older = ids[1] ?? "";
    expect(newest).not.toBe("");
    expect(older).not.toBe("");

    const setMarker = async (lastReadId: string) =>
      json("/api/v1/markers", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth(email)) },
        body: JSON.stringify({ notifications: { last_read_id: lastReadId } }),
      });

    expect((await setMarker(older)).status).toBe(200);
    expect(await unreadCount(email)).toBe(1);

    expect((await setMarker(newest)).status).toBe(200);
    expect(await unreadCount(email)).toBe(0);
  });
});
