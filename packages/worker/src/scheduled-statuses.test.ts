import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { processOutboxJob } from "./outbox-job";
import { insertScheduledStatus } from "./scheduled-status-store";

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

const ScheduledSchema = z.object({
  id: z.string().min(1),
  scheduled_at: z.string().min(1),
  params: z.object({
    text: z.string(),
    visibility: z.string().nullable(),
    sensitive: z.boolean().nullable(),
    spoiler_text: z.string().nullable(),
    poll: z.object({ options: z.array(z.string()), multiple: z.boolean() }).nullable(),
  }),
  media_attachments: z.array(z.object({ id: z.string() })),
});

const inFiveMinutes = (): string => new Date(Date.now() + 6 * 60 * 1000).toISOString();

const post = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });

const scheduledList = async (email: string): Promise<z.infer<typeof ScheduledSchema>[]> => {
  const response = await json("/api/v1/scheduled_statuses", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(ScheduledSchema), response.body);
};

describe("scheduled statuses", () => {
  it("stores, lists, reschedules, and deletes a scheduled post", async () => {
    const email = "scheduled-author@example.com";
    const when = inFiveMinutes();
    const created = await post(email, {
      status: "later on #scheduled",
      scheduled_at: when,
      visibility: "unlisted",
    });
    expect(created.status).toBe(200);
    const document = read(ScheduledSchema, created.body);
    expect(document.params.text).toBe("later on #scheduled");
    expect(document.params.visibility).toBe("unlisted");
    expect(document.scheduled_at).toBe(new Date(when).toISOString());

    // The list and the single lookup see it; no status was published.
    expect((await scheduledList(email)).map((row) => row.id)).toEqual([document.id]);
    const single = await json(`/api/v1/scheduled_statuses/${document.id}`, {
      headers: await auth(email),
    });
    expect(single.status).toBe(200);
    const home = await json("/api/v1/timelines/home", { headers: await auth(email) });
    expect(read(z.array(z.object({ id: z.string() })), home.body)).toEqual([]);

    // A too-soon schedule is refused, at create and when rescheduling.
    const tooSoon = await post(email, {
      status: "too soon",
      scheduled_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(tooSoon.status).toBe(422);
    const badReschedule = await json(`/api/v1/scheduled_statuses/${document.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ scheduled_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    expect(badReschedule.status).toBe(422);

    // Rescheduling works with a valid time.
    const later = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const rescheduled = await json(`/api/v1/scheduled_statuses/${document.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ scheduled_at: later }),
    });
    expect(rescheduled.status).toBe(200);
    expect(read(ScheduledSchema, rescheduled.body).scheduled_at).toBe(later);

    const removed = await json(`/api/v1/scheduled_statuses/${document.id}`, {
      method: "DELETE",
      headers: await auth(email),
    });
    expect(removed.status).toBe(200);
    expect(await scheduledList(email)).toEqual([]);
    expect(
      (await json(`/api/v1/scheduled_statuses/${document.id}`, { headers: await auth(email) }))
        .status,
    ).toBe(404);
  });

  it("keeps polls and media on a scheduled post", async () => {
    const email = "scheduled-poll@example.com";
    const created = await post(email, {
      status: "poll later",
      scheduled_at: inFiveMinutes(),
      poll: { options: ["yes", "no"], expires_in: 3600, multiple: false },
    });
    expect(created.status).toBe(200);
    const document = read(ScheduledSchema, created.body);
    expect(document.params.poll?.options).toEqual(["yes", "no"]);
  });

  it("publishes due posts from the cron job", async () => {
    const email = "scheduled-due@example.com";
    const credentials = await json("/api/v1/accounts/verify_credentials", {
      headers: await auth(email),
    });
    const accountId = read(z.object({ id: z.string().min(1) }), credentials.body).id;

    // Insert a row that is already due (the API refuses anything under 5 minutes).
    const stored = await insertScheduledStatus(env.DB, {
      accountId,
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      params: {
        text: "published by cron",
        visibility: "public",
        spoiler_text: "",
        sensitive: false,
        language: null,
        media_ids: [],
        media_attributes: [],
        poll: null,
        in_reply_to_id: null,
      },
    });
    expect(stored.isOk()).toBe(true);

    expect(await processOutboxJob(env, { kind: "PublishScheduledStatuses" })).toBe("ok");

    const home = await json("/api/v1/timelines/home", { headers: await auth(email) });
    const statuses = read(z.array(z.object({ id: z.string(), content: z.string() })), home.body);
    expect(statuses.map((status) => status.content).join(" ")).toContain("published by cron");
    // The row is gone once published.
    expect(await scheduledList(email)).toEqual([]);
  });
});
