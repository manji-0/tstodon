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

const EmojiSchema = z.object({
  shortcode: z.string().min(1),
  url: z.string().min(1),
  static_url: z.string().min(1),
  visible_in_picker: z.boolean(),
});

describe("custom emojis", () => {
  it("lists the configured emojis", async () => {
    const response = await json("/api/v1/custom_emojis");
    expect(response.status).toBe(200);
    const emojis = read(z.array(EmojiSchema), response.body);
    expect(emojis.map((emoji) => emoji.shortcode)).toContain("tstodon");
    const emoji = emojis.find((entry) => entry.shortcode === "tstodon");
    expect(emoji?.static_url).toBe(emoji?.url);
  });

  it("exposes emojis used in a status body", async () => {
    const response = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("emoji-status@example.com")) },
      body: JSON.stringify({ status: "hello :tstodon: world" }),
    });
    expect(response.status).toBe(200);
    const status = read(z.object({ emojis: z.array(EmojiSchema) }), response.body);
    expect(status.emojis.map((emoji) => emoji.shortcode)).toContain("tstodon");
  });

  it("exposes emojis used in a display name", async () => {
    const email = "emoji-profile@example.com";
    const updated = await json("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ display_name: "Emoji :tstodon: Fan" }),
    });
    expect(updated.status).toBe(200);
    const account = read(z.object({ emojis: z.array(EmojiSchema) }), updated.body);
    expect(account.emojis.map((emoji) => emoji.shortcode)).toContain("tstodon");
  });
});
