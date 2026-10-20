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

const RelationshipSchema = z.object({
  id: z.string().min(1),
  following: z.boolean(),
  showing_reblogs: z.boolean(),
  notifying: z.boolean(),
  languages: z.array(z.string()),
});

const accountFor = async (email: string): Promise<z.infer<typeof MastodonAccountPreviewSchema>> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body);
};

const post = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const follow = async (
  email: string,
  targetId: string,
  query = "",
): Promise<{ status: number; body: unknown }> =>
  json(`/api/v1/accounts/${targetId}/follow${query}`, {
    method: "POST",
    headers: await auth(email),
  });

const homeIds = async (email: string): Promise<string[]> => {
  const response = await json("/api/v1/timelines/home", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(z.object({ id: z.string().min(1) })), response.body).map(
    (status) => status.id,
  );
};

describe("follow options", () => {
  it("reports reblogs, notify, and languages on the relationship", async () => {
    const followerEmail = "followopts-viewer@example.com";
    await accountFor(followerEmail);
    const author = await accountFor("followopts-author@example.com");

    const followed = await follow(
      followerEmail,
      author.id,
      "?reblogs=false&notify=true&languages[]=ja",
    );
    expect(followed.status).toBe(200);
    const relationship = read(RelationshipSchema, followed.body);
    expect(relationship.following).toBe(true);
    expect(relationship.showing_reblogs).toBe(false);
    expect(relationship.notifying).toBe(true);
    expect(relationship.languages).toEqual(["ja"]);

    // Following again updates only what was sent.
    const again = await follow(followerEmail, author.id, "?reblogs=true");
    const updated = read(RelationshipSchema, again.body);
    expect(updated.showing_reblogs).toBe(true);
    expect(updated.notifying).toBe(true);
    expect(updated.languages).toEqual(["ja"]);
  });

  it("hides boosts from an account followed with reblogs=false", async () => {
    const followerEmail = "followopts-reblog-viewer@example.com";
    await accountFor(followerEmail);
    const author = await accountFor("followopts-reblog-author@example.com");
    const boosted = await post("followopts-reblog-author@example.com", {
      status: "a quotable post",
    });
    const reblog = await json(`/api/v1/statuses/${boosted}/reblog`, {
      method: "POST",
      headers: await auth("followopts-reblog-author@example.com"),
    });
    expect(reblog.status).toBe(200);
    const reblogId = read(z.object({ id: z.string().min(1) }), reblog.body).id;

    await follow(followerEmail, author.id, "?reblogs=false");
    // The boost row itself is gone; the author's original post still shows.
    expect(await homeIds(followerEmail)).not.toContain(reblogId);

    // Turning reblogs back on brings the boost back.
    await follow(followerEmail, author.id, "?reblogs=true");
    expect(await homeIds(followerEmail)).toContain(reblogId);
  });

  it("keeps only the chosen languages in the home timeline", async () => {
    const followerEmail = "followopts-lang-viewer@example.com";
    await accountFor(followerEmail);
    const author = await accountFor("followopts-lang-author@example.com");
    const japanese = await post("followopts-lang-author@example.com", {
      status: "こんにちは",
      language: "ja",
    });
    const english = await post("followopts-lang-author@example.com", {
      status: "hello",
      language: "en",
    });
    const unknown = await post("followopts-lang-author@example.com", { status: "no language" });

    await follow(followerEmail, author.id, "?languages[]=ja");
    const home = await homeIds(followerEmail);
    expect(home).toContain(japanese);
    expect(home).toContain(unknown);
    expect(home).not.toContain(english);
  });

  it("notifies a follower who asked for every new status", async () => {
    const notifierEmail = "followopts-notify-on@example.com";
    const quietEmail = "followopts-notify-off@example.com";
    await accountFor(notifierEmail);
    await accountFor(quietEmail);
    const author = await accountFor("followopts-notify-author@example.com");
    await follow(notifierEmail, author.id, "?notify=true");
    await follow(quietEmail, author.id);

    await post("followopts-notify-author@example.com", { status: "something new" });

    const notifications = async (email: string): Promise<z.infer<typeof NotificationSchema>[]> => {
      const response = await json("/api/v1/notifications", { headers: await auth(email) });
      expect(response.status).toBe(200);
      return read(z.array(NotificationSchema), response.body);
    };
    const notifier = await notifications(notifierEmail);
    expect(notifier.map((notification) => notification.type)).toContain("status");
    expect(await notifications(quietEmail)).toEqual([]);
  });
});

const NotificationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  account: MastodonAccountPreviewSchema,
  status: z.object({ id: z.string().min(1) }).nullable(),
});
