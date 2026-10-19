import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "./schemas";

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

const EnvelopeSchema = z.object({
  accounts: z.array(MastodonAccountPreviewSchema),
  statuses: z.array(z.object({ id: z.string().min(1) })),
  notification_groups: z.array(
    z.object({
      group_key: z.string().min(1),
      notifications_count: z.number(),
      type: z.string().min(1),
      most_recent_notification_id: z.string().min(1),
      sample_account_ids: z.array(z.string().min(1)),
      status_id: z.string().min(1).optional(),
      page_min_id: z.string().optional(),
      page_max_id: z.string().optional(),
      latest_page_notification_at: z.string().optional(),
    }),
  ),
});

const credentials = async (email: string): Promise<{ id: string; username: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  const account = read(MastodonAccountPreviewSchema, response.body);
  return { id: account.id, username: account.username };
};

const postStatus = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const favourite = async (email: string, statusId: string): Promise<void> => {
  const response = await json(`/api/v1/statuses/${statusId}/favourite`, {
    method: "POST",
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
};

describe("grouped notifications", () => {
  it("folds favourites of one status into a single group", async () => {
    const authorEmail = "group-author@example.com";
    const statusId = await postStatus(authorEmail, { status: "group me" });
    const fans = ["group-fan-a@example.com", "group-fan-b@example.com", "group-fan-c@example.com"];
    for (const fan of fans) {
      await favourite(fan, statusId);
    }

    const response = await json("/api/v2/notifications", { headers: await auth(authorEmail) });
    expect(response.status).toBe(200);
    const envelope = read(EnvelopeSchema, response.body);
    const group = envelope.notification_groups.find((entry) => entry.status_id === statusId);
    expect(group).toBeDefined();
    expect(group?.type).toBe("favourite");
    expect(group?.notifications_count).toBe(3);
    expect(group?.sample_account_ids).toHaveLength(3);
    expect(group?.page_min_id).toBeDefined();
    expect(group?.latest_page_notification_at).toBeDefined();
    // The referenced accounts and status travel in the envelope.
    expect(envelope.accounts.map((account) => account.id)).toEqual(
      expect.arrayContaining(group?.sample_account_ids ?? []),
    );
    expect(envelope.statuses.map((status) => status.id)).toContain(statusId);

    // The single-group endpoint returns the same group without page ids.
    const single = await json(`/api/v2/notifications/${group?.group_key ?? ""}`, {
      headers: await auth(authorEmail),
    });
    expect(single.status).toBe(200);
    const one = read(EnvelopeSchema, single.body);
    expect(one.notification_groups).toHaveLength(1);
    expect(one.notification_groups[0]?.page_min_id).toBeUndefined();

    const accounts = await json(`/api/v2/notifications/${group?.group_key ?? ""}/accounts`, {
      headers: await auth(authorEmail),
    });
    expect(accounts.status).toBe(200);
    expect(read(z.array(MastodonAccountPreviewSchema), accounts.body)).toHaveLength(3);

    // Dismissing the group empties the list, and unread_count drops with it.
    const unread = await json("/api/v2/notifications/unread_count", {
      headers: await auth(authorEmail),
    });
    expect(read(z.object({ count: z.number() }), unread.body).count).toBe(1);

    const dismissed = await json(`/api/v2/notifications/${group?.group_key ?? ""}/dismiss`, {
      method: "POST",
      headers: await auth(authorEmail),
    });
    expect(dismissed.status).toBe(200);
    const after = await json("/api/v2/notifications", { headers: await auth(authorEmail) });
    expect(read(EnvelopeSchema, after.body).notification_groups).toHaveLength(0);
  });

  it("keeps ungrouped types in their own groups", async () => {
    const authorEmail = "group-mention-author@example.com";
    const author = await credentials(authorEmail);
    const mentioner = "group-mentioner@example.com";
    await credentials(mentioner);
    await postStatus(mentioner, { status: `@${author.username} hi` });

    const grouped = await json("/api/v2/notifications", { headers: await auth(authorEmail) });
    const envelope = read(EnvelopeSchema, grouped.body);
    const mention = envelope.notification_groups.find((entry) => entry.type === "mention");
    expect(mention).toBeDefined();
    expect(mention?.notifications_count).toBe(1);
    expect(mention?.group_key.startsWith("ungrouped-")).toBe(true);
    expect(mention?.status_id).toBeDefined();
  });

  it("paginates by group and requires auth", async () => {
    const authorEmail = "group-page-author@example.com";
    const first = await postStatus(authorEmail, { status: "page one" });
    const second = await postStatus(authorEmail, { status: "page two" });
    await favourite("group-page-fan-a@example.com", first);
    await favourite("group-page-fan-b@example.com", second);

    const page = await json("/api/v2/notifications?limit=1", { headers: await auth(authorEmail) });
    expect(read(EnvelopeSchema, page.body).notification_groups).toHaveLength(1);

    expect((await json("/api/v2/notifications")).status).toBe(401);
  });
});
