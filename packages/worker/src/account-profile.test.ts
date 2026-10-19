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

const AccountSchema = z.object({
  id: z.string().min(1),
  note: z.string(),
  bot: z.boolean(),
  discoverable: z.boolean(),
  fields: z.array(
    z.object({ name: z.string(), value: z.string(), verified_at: z.string().nullable() }),
  ),
});

const updateCredentials = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/accounts/update_credentials", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });

describe("account profiles", () => {
  it("stores the bio, fields, and flags and reports them everywhere", async () => {
    const email = "profile-owner@example.com";
    const updated = await updateCredentials(email, {
      display_name: "Profile Owner",
      note: "hello https://example.org/me",
      bot: true,
      discoverable: false,
      fields: [
        { name: "Website", value: "https://example.org" },
        { name: "  ", value: "ignored" },
      ],
    });
    expect(updated.status).toBe(200);
    const account = read(AccountSchema, updated.body);
    // The bio is escaped and wrapped, like status content.
    expect(account.note).toContain("hello");
    expect(account.note.startsWith("<p>")).toBe(true);
    expect(account.bot).toBe(true);
    expect(account.discoverable).toBe(false);
    expect(account.fields.map((field) => field.name)).toEqual(["Website"]);
    expect(account.fields[0]?.verified_at).toBeNull();

    // The public profile endpoint agrees.
    const fetched = await json(`/api/v1/accounts/${account.id}`);
    const publicAccount = read(AccountSchema, fetched.body);
    expect(publicAccount.note).toBe(account.note);
    expect(publicAccount.fields.map((field) => field.name)).toEqual(["Website"]);

    // Statuses embed the same profile.
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "profile post" }),
    });
    const status = read(z.object({ account: AccountSchema }), created.body).account;
    expect(status.bot).toBe(true);
    expect(status.note).toContain("hello");
    expect(status.fields.map((field) => field.name)).toEqual(["Website"]);
  });

  it("keeps omitted profile fields and replaces them when provided", async () => {
    const email = "profile-partial@example.com";
    await updateCredentials(email, {
      note: "first bio",
      fields: [{ name: "One", value: "1" }],
    });

    const renamed = await updateCredentials(email, { display_name: "Only Name" });
    const afterRename = read(AccountSchema, renamed.body);
    expect(afterRename.note).toContain("first bio");
    expect(afterRename.fields.map((field) => field.name)).toEqual(["One"]);

    const replaced = await updateCredentials(email, {
      fields: [
        { name: "Two", value: "2" },
        { name: "Three", value: "3" },
      ],
    });
    expect(read(AccountSchema, replaced.body).fields.map((field) => field.name)).toEqual([
      "Two",
      "Three",
    ]);

    const cleared = await updateCredentials(email, { note: "" });
    expect(read(AccountSchema, cleared.body).note).not.toContain("first bio");
  });
});
