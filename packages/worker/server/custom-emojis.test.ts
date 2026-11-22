import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

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

  // `CustomEmoji::SCAN_RE`: no letter, mark, digit or colon on either side.
  it("finds no emoji whose shortcode is glued to a word or a colon", async () => {
    const response = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("emoji-glued@example.com")) },
      body: JSON.stringify({ status: "x:tstodon: :tstodon:x :tstodon:: é:tstodon:" }),
    });
    expect(response.status).toBe(200);
    const status = read(z.object({ emojis: z.array(EmojiSchema) }), response.body);
    expect(status.emojis).toEqual([]);
  });

  // `Status#emojis` scans the poll's options, and `Poll#emojis` scans them alone.
  it("exposes emojis used in a poll option on the status and on the poll", async () => {
    const headers = {
      "content-type": "application/json",
      ...(await auth("emoji-poll@example.com")),
    };
    const response = await json("/api/v1/statuses", {
      method: "POST",
      headers,
      body: JSON.stringify({
        status: "which?",
        poll: { options: ["yes :tstodon:", "no"], expires_in: 3600 },
      }),
    });
    expect(response.status).toBe(200);
    const PollStatus = z.object({
      emojis: z.array(EmojiSchema),
      poll: z.object({ id: z.string(), emojis: z.array(EmojiSchema) }),
    });
    const status = read(PollStatus, response.body);
    expect(status.emojis.map((emoji) => emoji.shortcode)).toEqual(["tstodon"]);
    expect(status.poll.emojis.map((emoji) => emoji.shortcode)).toEqual(["tstodon"]);

    const poll = await json(`/api/v1/polls/${status.poll.id}`, { headers });
    expect(poll.status).toBe(200);
    const shown = read(z.object({ emojis: z.array(EmojiSchema) }), poll.body);
    expect(shown.emojis.map((emoji) => emoji.shortcode)).toEqual(["tstodon"]);
  });

  // `Account#emojis` scans the note, the display name and each field's name and value.
  it.each([
    ["note", { note: "I like :tstodon:" }],
    ["field name", { fields_attributes: [{ name: ":tstodon:", value: "yes" }] }],
    ["field value", { fields_attributes: [{ name: "Likes", value: ":tstodon:" }] }],
  ])("exposes emojis used in a profile's %s", async (where, profile) => {
    const email = `emoji-profile-${where.replace(" ", "-")}@example.com`;
    const updated = await json("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ display_name: "Plain", ...profile }),
    });
    expect(updated.status).toBe(200);
    const Account = z.object({ id: z.string(), emojis: z.array(EmojiSchema) });
    const account = read(Account, updated.body);
    expect(account.emojis.map((emoji) => emoji.shortcode)).toEqual(["tstodon"]);

    const shown = read(Account, (await json(`/api/v1/accounts/${account.id}`)).body);
    expect(shown.emojis.map((emoji) => emoji.shortcode)).toEqual(["tstodon"]);
  });
});
