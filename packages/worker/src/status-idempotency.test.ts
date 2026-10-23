import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

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

const StatusSchema = z.object({ id: z.string().min(1), content: z.string() });

const post = async (
  email: string,
  body: Record<string, unknown>,
  key?: string,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/statuses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { "Idempotency-Key": key }),
      ...(await auth(email)),
    },
    body: JSON.stringify(body),
  });

describe("status idempotency", () => {
  it("returns the first result for a repeated key and posts once", async () => {
    const email = "idempotency-author@example.com";
    const accountId = read(
      MastodonAccountPreviewSchema,
      (await json("/api/v1/accounts/verify_credentials", { headers: await auth(email) })).body,
    ).id;

    const first = await post(email, { status: "only once" }, "key-1");
    expect(first.status).toBe(200);
    const created = read(StatusSchema, first.body);

    const second = await post(email, { status: "a different body" }, "key-1");
    expect(second.status).toBe(200);
    expect(read(StatusSchema, second.body).id).toBe(created.id);

    const other = await post(email, { status: "second post" }, "key-2");
    expect(read(StatusSchema, other.body).id).not.toBe(created.id);

    const statuses = await json(`/api/v1/accounts/${accountId}/statuses`);
    const ids = read(z.array(StatusSchema), statuses.body).map((status) => status.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(created.id);
  });

  it("releases the key when the create fails", async () => {
    const email = "idempotency-retry@example.com";

    const failed = await post(email, { status: "" }, "key-retry");
    expect(failed.status).toBe(422);

    const retried = await post(email, { status: "now with text" }, "key-retry");
    expect(retried.status).toBe(200);
    expect(read(StatusSchema, retried.body).content).toContain("now with text");
  });

  it("scopes keys per account", async () => {
    const alice = "idempotency-alice@example.com";
    const bob = "idempotency-bob@example.com";

    const alices = await post(alice, { status: "alice" }, "shared-key");
    const bobs = await post(bob, { status: "bob" }, "shared-key");
    expect(alices.status).toBe(200);
    expect(bobs.status).toBe(200);
    expect(read(StatusSchema, bobs.body).id).not.toBe(read(StatusSchema, alices.body).id);
  });
});
