import { SELF, env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";
import { postV1Statuses } from "./routes/statuses/create";

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

  it("returns the same scheduled status for a repeated key and schedules once", async () => {
    const email = "idempotency-scheduled@example.com";
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const ScheduledSchema = z.object({ id: z.string().min(1), scheduled_at: z.string() });

    const first = await post(email, { status: "later", scheduled_at: scheduledAt }, "key-sched");
    expect(first.status).toBe(200);
    const created = read(ScheduledSchema, first.body);

    const retried = await post(email, { status: "later", scheduled_at: scheduledAt }, "key-sched");
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual(first.body);

    const scheduled = await json("/api/v1/scheduled_statuses", { headers: await auth(email) });
    expect(read(z.array(ScheduledSchema), scheduled.body).map((row) => row.id)).toEqual([
      created.id,
    ]);
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

  it("records the key once the status exists, even when rendering it fails", async () => {
    const email = "idempotency-unrendered@example.com";
    const account = await signedInAccount(email);
    // During the first request, author-presentation reads fail once the status
    // row is written: every render of the new status fails, the checks before
    // the write do not.
    let firstRequest = true;
    let statusWritten = false;
    let renderFailed = false;
    const failingFirstRender = new Proxy(env.DB, {
      get: (db, property) => {
        if (property === "prepare") {
          return (query: string) => {
            if (/INSERT INTO statuses/i.test(query)) {
              statusWritten = true;
            }
            if (firstRequest && statusWritten && /FROM account_moderation/i.test(query)) {
              renderFailed = true;
              throw new Error("D1 unavailable");
            }
            return db.prepare(query);
          };
        }
        const value: unknown = Reflect.get(db, property);
        return typeof value === "function" ? value.bind(db) : value;
      },
    });
    const app = new Hono<{ Bindings: Env }>().post("/api/v1/statuses", postV1Statuses);
    const create = async (): Promise<{ status: number; body: unknown }> => {
      const response = await app.request(
        "https://example.com/api/v1/statuses",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "key-unrendered",
            ...(await auth(email)),
          },
          body: JSON.stringify({ status: "posted once" }),
        },
        { ...env, DB: failingFirstRender },
      );
      return { status: response.status, body: await response.json() };
    };

    const first = await create();
    firstRequest = false;
    expect(renderFailed).toBe(true);
    expect(first.status).toBe(500);

    const retried = await create();
    expect(retried.status).toBe(200);
    const created = read(StatusSchema, retried.body);
    expect(created.content).toContain("posted once");

    const statuses = await json(`/api/v1/accounts/${account.id}/statuses`);
    expect(read(z.array(StatusSchema), statuses.body).map((status) => status.id)).toEqual([
      created.id,
    ]);
  });
});
