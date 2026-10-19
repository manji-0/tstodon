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

const NotificationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  account: z.object({ id: z.string().min(1) }),
});

const credentials = async (email: string): Promise<{ id: string; username: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  const account = read(MastodonAccountPreviewSchema, response.body);
  return { id: account.id, username: account.username };
};

const notifications = async (
  email: string,
  query = "",
): Promise<z.infer<typeof NotificationSchema>[]> => {
  const response = await json(`/api/v1/notifications${query}`, { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(NotificationSchema), response.body);
};

describe("notification filters", () => {
  it("filters by types, exclude_types, account_id, and max_id", async () => {
    const viewerEmail = "notif-filter-viewer@example.com";
    const actorEmail = "notif-filter-actor@example.com";
    const viewer = await credentials(viewerEmail);
    const actor = await credentials(actorEmail);

    const followed = await json(`/api/v1/accounts/${viewer.id}/follow`, {
      method: "POST",
      headers: await auth(actorEmail),
    });
    expect(followed.status).toBe(200);
    const mention = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(actorEmail)) },
      body: JSON.stringify({ status: `@${viewer.username} hello there` }),
    });
    expect(mention.status).toBe(200);

    const all = await notifications(viewerEmail);
    expect(all.map((entry) => entry.type)).toEqual(expect.arrayContaining(["follow", "mention"]));

    const onlyMentions = await notifications(viewerEmail, "?types[]=mention");
    expect(onlyMentions.map((entry) => entry.type)).toEqual(["mention"]);

    const withoutMentions = await notifications(viewerEmail, "?exclude_types[]=mention");
    expect(withoutMentions.map((entry) => entry.type)).not.toContain("mention");
    expect(withoutMentions.map((entry) => entry.type)).toContain("follow");

    const bare = await notifications(viewerEmail, "?types=mention");
    expect(bare.map((entry) => entry.type)).toEqual(["mention"]);

    const fromActor = await notifications(viewerEmail, `?account_id=${actor.id}`);
    expect(fromActor.length).toBeGreaterThan(0);
    expect(fromActor.every((entry) => entry.account.id === actor.id)).toBe(true);

    const newest = all[0];
    expect(newest).toBeDefined();
    const paged = await notifications(viewerEmail, `?max_id=${newest?.id ?? ""}`);
    expect(paged.map((entry) => entry.id)).not.toContain(newest?.id);
    expect(paged.length).toBe(all.length - 1);
  });

  it("pages with max_id, since_id, and min_id", async () => {
    const viewerEmail = "notif-cursor-viewer@example.com";
    const actorEmail = "notif-cursor-actor@example.com";
    const viewer = await credentials(viewerEmail);
    await credentials(actorEmail);

    const mention = async (suffix: string): Promise<void> => {
      const response = await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await auth(actorEmail)) },
        body: JSON.stringify({ status: `@${viewer.username} cursor ${suffix}` }),
      });
      expect(response.status).toBe(200);
    };
    await mention("one");
    await mention("two");
    await mention("three");

    const all = await notifications(viewerEmail);
    expect(all).toHaveLength(3);
    const newest = all[0];
    const middle = all[1];
    const oldest = all[2];
    expect(newest && middle && oldest).toBeTruthy();

    expect((await notifications(viewerEmail, "?limit=2")).map((row) => row.id)).toEqual([
      newest?.id,
      middle?.id,
    ]);
    expect(
      (await notifications(viewerEmail, `?max_id=${middle?.id ?? ""}`)).map((row) => row.id),
    ).toEqual([oldest?.id]);
    expect(
      (await notifications(viewerEmail, `?since_id=${oldest?.id ?? ""}`)).map((row) => row.id),
    ).toEqual([newest?.id, middle?.id]);
    // min_id pages upward, so the oldest of the newer rows comes first.
    expect(
      (await notifications(viewerEmail, `?min_id=${oldest?.id ?? ""}`)).map((row) => row.id),
    ).toEqual([middle?.id, newest?.id]);
  });
});
