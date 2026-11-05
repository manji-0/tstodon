import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

const call = async (
  email: string,
  path: string,
  init: Readonly<{ method?: string; body?: Record<string, unknown> }> = {},
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(await authHeaders(email)),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    body: contentType.includes("json") ? await response.json() : await response.text(),
  };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const post = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await call(email, "/api/v1/statuses", { method: "POST", body });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string() }), response.body).id;
};

const notificationTypesFrom = async (email: string, senderId: string): Promise<string[]> => {
  const response = await call(email, "/api/v1/notifications");
  expect(response.status).toBe(200);
  return read(
    z.array(z.object({ type: z.string(), account: z.object({ id: z.string() }) })),
    response.body,
  )
    .filter((notification) => notification.account.id === senderId)
    .map((notification) => notification.type);
};

const person = async (email: string) => {
  const account = await signedInAccount(email);
  return { email, id: account.id, username: account.username };
};

const relate = async (email: string, targetId: string, action: string, body = {}) =>
  expect(
    (await call(email, `/api/v1/accounts/${targetId}/${action}`, { method: "POST", body })).status,
  ).toBe(200);

// The notification list hides senders the reader blocks or mutes, so each case
// lifts the block or mute again before reading: what was silenced must never
// have been recorded, as with Mastodon's NotifyService.
describe("notifications from a silenced sender", () => {
  it("records no quoted_update from an author the quoter blocks", async () => {
    const author = await person("silence-quote-author@example.com");
    const quoter = await person("silence-quote-quoter@example.com");
    const original = await post(author.email, { status: "quote me" });
    await post(quoter.email, { status: "quoting", quoted_status_id: original });

    await relate(quoter.email, author.id, "block");
    const edited = await call(author.email, `/api/v1/statuses/${original}`, {
      method: "PUT",
      body: { status: "quote me, edited" },
    });
    expect(edited.status).toBe(200);
    await relate(quoter.email, author.id, "unblock");

    expect(await notificationTypesFrom(quoter.email, author.id)).not.toContain("quoted_update");
  });

  it("records no status, mention or reblog from an author whose notifications are muted", async () => {
    const author = await person("silence-mute-author@example.com");
    const reader = await person("silence-mute-reader@example.com");
    const own = await post(reader.email, { status: "boost me" });
    await relate(reader.email, author.id, "follow", { notify: true });

    await relate(reader.email, author.id, "mute", { notifications: true });
    await post(author.email, { status: "a post the follower asked to hear about" });
    await post(author.email, { status: `hello @${reader.username}` });
    expect(
      (await call(author.email, `/api/v1/statuses/${own}/reblog`, { method: "POST" })).status,
    ).toBe(200);
    await relate(reader.email, author.id, "unmute");

    expect(await notificationTypesFrom(reader.email, author.id)).toEqual([]);

    // The same activity from an unmuted author is delivered.
    await post(author.email, { status: `hello again @${reader.username}` });
    expect(await notificationTypesFrom(reader.email, author.id)).toEqual(
      expect.arrayContaining(["status", "mention"]),
    );
  });
});
