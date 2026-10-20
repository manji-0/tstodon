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

const SourceSchema = z.object({
  privacy: z.string(),
  sensitive: z.boolean(),
  note: z.string(),
  quote_policy: z.string(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })),
});

const CredentialSchema = z.object({
  id: z.string().min(1),
  source: SourceSchema,
});

const StatusSchema = z.object({
  id: z.string().min(1),
  visibility: z.string(),
});

const credentials = async (email: string): Promise<z.infer<typeof CredentialSchema>> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(CredentialSchema, response.body);
};

const patchJson = async (email: string, body: Record<string, unknown>) =>
  json("/api/v1/accounts/update_credentials", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });

describe("account source", () => {
  it("reports the defaults and lets update_credentials change them", async () => {
    const email = "source-author@example.com";
    const before = await credentials(email);
    expect(before.source.privacy).toBe("public");
    expect(before.source.quote_policy).toBe("public");
    expect(before.source.sensitive).toBe(false);
    expect(before.source.note).toBe("");

    const updated = await patchJson(email, {
      note: "raw bio text",
      fields: [{ name: "site", value: "https://example.com" }],
      source: { privacy: "private", quote_policy: "followers" },
    });
    expect(updated.status).toBe(200);
    const document = read(CredentialSchema, updated.body);
    expect(document.source.privacy).toBe("private");
    expect(document.source.quote_policy).toBe("followers");
    expect(document.source.note).toBe("raw bio text");
    expect(document.source.fields).toEqual([{ name: "site", value: "https://example.com" }]);

    const after = await credentials(email);
    expect(after.source.privacy).toBe("private");
    expect(after.source.quote_policy).toBe("followers");

    // A post without a visibility now uses the private default.
    const posted = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "defaults to private" }),
    });
    expect(posted.status).toBe(200);
    const status = read(StatusSchema, posted.body);
    expect(status.visibility).toBe("private");

    // And that followers-only post is not quotable by anyone else.
    const stranger = await json("/api/v1/statuses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await auth("source-stranger@example.com")),
      },
      body: JSON.stringify({ status: "quoting", quoted_status_id: status.id }),
    });
    expect(stranger.status).toBe(404);
  });

  it("accepts form-encoded source keys", async () => {
    const email = "source-form@example.com";
    const response = await json("/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(await auth(email)),
      },
      body: "source[privacy]=unlisted&source[quote_policy]=nobody",
    });
    expect(response.status).toBe(200);
    const document = read(CredentialSchema, response.body);
    expect(document.source.privacy).toBe("unlisted");
    expect(document.source.quote_policy).toBe("nobody");

    const posted = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "defaults to unlisted" }),
    });
    expect(read(StatusSchema, posted.body).visibility).toBe("unlisted");
  });

  it("refuses an unknown privacy or quote policy", async () => {
    const email = "source-invalid@example.com";
    expect((await patchJson(email, { source: { privacy: "secret" } })).status).toBe(422);
    expect((await patchJson(email, { source: { quote_policy: "maybe" } })).status).toBe(422);
  });
});
