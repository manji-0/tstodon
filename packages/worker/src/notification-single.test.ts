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

const NotificationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  account: z.object({ id: z.string().min(1), acct: z.string().min(1) }),
  status: z.object({ id: z.string().min(1) }).nullable(),
  filtered: z
    .array(
      z.object({
        filter: z.object({ title: z.string() }),
        keyword_matches: z.array(z.string()),
      }),
    )
    .optional(),
});

describe("single notification", () => {
  it("returns one notification and 404s for unknown or other accounts' ids", async () => {
    const viewerEmail = "single-notif-viewer@example.com";
    const viewer = read(
      z.object({ username: z.string().min(1) }),
      (await json("/api/v1/accounts/verify_credentials", { headers: await auth(viewerEmail) }))
        .body,
    ).username;

    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await auth("single-notif-sender@example.com")),
      },
      body: JSON.stringify({ status: `@${viewer} hello there` }),
    });
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;

    const list = await json("/api/v1/notifications", { headers: await auth(viewerEmail) });
    const notification = read(z.array(NotificationSchema), list.body).find(
      (row) => row.status?.id === statusId,
    );
    expect(notification).toBeDefined();

    const single = await json(`/api/v1/notifications/${notification?.id ?? ""}`, {
      headers: await auth(viewerEmail),
    });
    expect(single.status).toBe(200);
    const fetched = read(NotificationSchema, single.body);
    expect(fetched.id).toBe(notification?.id);
    expect(fetched.type).toBe("mention");
    expect(fetched.status?.id).toBe(statusId);

    expect((await json(`/api/v1/notifications/${notification?.id ?? ""}`)).status).toBe(401);

    // Another account cannot read it, and an unknown id is a 404.
    expect(
      (
        await json(`/api/v1/notifications/${notification?.id ?? ""}`, {
          headers: await auth("single-notif-other@example.com"),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await json("/api/v1/notifications/does-not-exist", {
          headers: await auth(viewerEmail),
        })
      ).status,
    ).toBe(404);

    // `unread_count` still resolves to its own route rather than `:id`.
    const unread = await json("/api/v1/notifications/unread_count", {
      headers: await auth(viewerEmail),
    });
    expect(unread.status).toBe(200);
    expect(read(z.object({ count: z.number() }), unread.body).count).toBeGreaterThanOrEqual(1);

    // A filter on the notification context is reported on the single
    // notification too, exactly as in the list.
    const created2 = await json("/api/v1/statuses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await auth("single-notif-sender2@example.com")),
      },
      body: JSON.stringify({ status: `@${viewer} spoiler alert` }),
    });
    const status2 = read(z.object({ id: z.string().min(1) }), created2.body).id;
    const list2 = await json("/api/v1/notifications", { headers: await auth(viewerEmail) });
    const notification2 = read(z.array(NotificationSchema), list2.body).find(
      (row) => row.status?.id === status2,
    );

    const createdFilter = await json("/api/v2/filters", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(viewerEmail)) },
      body: JSON.stringify({
        title: "spoiler",
        context: ["notifications"],
        keywords: ["spoiler"],
      }),
    });
    expect(createdFilter.status).toBe(200);

    const singleFiltered = await json(`/api/v1/notifications/${notification2?.id ?? ""}`, {
      headers: await auth(viewerEmail),
    });
    expect(read(NotificationSchema, singleFiltered.body).filtered?.[0]?.filter.title).toBe(
      "spoiler",
    );

    // Dismissing hides it from the list; like Mastodon, the single
    // notification is still addressable by id.
    const dismissed = await json(`/api/v1/notifications/${notification?.id ?? ""}/dismiss`, {
      method: "POST",
      headers: await auth(viewerEmail),
    });
    expect(dismissed.status).toBe(200);
    const afterDismiss = await json("/api/v1/notifications", { headers: await auth(viewerEmail) });
    expect(read(z.array(NotificationSchema), afterDismiss.body).map((row) => row.id)).not.toContain(
      notification?.id,
    );
    expect(
      (
        await json(`/api/v1/notifications/${notification?.id ?? ""}`, {
          headers: await auth(viewerEmail),
        })
      ).status,
    ).toBe(200);
  });
});
