import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const send = async (email: string, method: string, path: string, body: Record<string, unknown>) =>
  json(path, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });

const inTenMinutes = (): string => new Date(Date.now() + 10 * 60 * 1000).toISOString();

const ScheduledSchema = z.object({
  id: z.string(),
  params: z.object({
    text: z.string(),
    quoted_status_id: z.string().nullable(),
    quote_approval_policy: z.string().nullable(),
  }),
});

const StatusSchema = z.object({
  id: z.string(),
  content: z.string(),
  quote: z
    .object({ state: z.string(), quoted_status: z.object({ id: z.string() }).nullable() })
    .nullable(),
});

/** Schedule `text` quoting `quotedId`, then make it due at once. */
const scheduleQuote = async (email: string, quotedId: string, text: string) => {
  const created = await send(email, "POST", "/api/v1/statuses", {
    status: text,
    quoted_status_id: quotedId,
    scheduled_at: inTenMinutes(),
  });
  expect(created.status).toBe(200);
  const scheduled = read(ScheduledSchema, created.body);
  await env.DB.prepare("UPDATE scheduled_statuses SET scheduled_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - 60_000).toISOString(), scheduled.id)
    .run();
  return scheduled;
};

const publishDue = async () =>
  expect(await processOutboxJob(env, { kind: "PublishScheduledStatuses" })).toBe("ok");

const statusesOf = async (email: string, accountId: string) => {
  const response = await json(`/api/v1/accounts/${accountId}/statuses`, {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(z.array(StatusSchema), response.body);
};

const scheduledCount = async (accountId: string) =>
  read(
    z.object({ n: z.number() }),
    await env.DB.prepare("SELECT COUNT(*) AS n FROM scheduled_statuses WHERE account_id = ?")
      .bind(accountId)
      .first(),
  ).n;

const postStatus = async (email: string, body: Record<string, unknown>) => {
  const response = await send(email, "POST", "/api/v1/statuses", body);
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body);
};

describe("scheduled quotes", () => {
  it("echoes quoted_status_id and publishes an accepted quote of a local status", async () => {
    const author = "sq-local-author@example.com";
    const quoter = "sq-local-quoter@example.com";
    const quoterAccount = await signedInAccount(quoter);
    const original = await postStatus(author, { status: "quote me later" });

    const scheduled = await scheduleQuote(quoter, original.id, "my later take");
    expect(scheduled.params.quoted_status_id).toBe(original.id);
    expect(scheduled.params.quote_approval_policy).toBe("public");
    const listed = await json("/api/v1/scheduled_statuses", { headers: await authHeaders(quoter) });
    expect(read(z.array(ScheduledSchema), listed.body)[0]?.params.quoted_status_id).toBe(
      original.id,
    );
    // Nothing is published before it is due.
    expect(await statusesOf(quoter, quoterAccount.id)).toEqual([]);

    await publishDue();

    const [published] = await statusesOf(quoter, quoterAccount.id);
    expect(published?.quote).toEqual({ state: "accepted", quoted_status: expect.anything() });
    expect(published?.quote?.quoted_status?.id).toBe(original.id);
    expect(published?.content).toContain("quote-inline");
    expect(await scheduledCount(quoterAccount.id)).toBe(0);
  });

  it("sends a QuoteRequest when a scheduled quote of a remote status is published", async () => {
    const email = "sq-remote-alice@example.com";
    const alice = await signedInAccount(email);
    const bob = await remoteActor("sq-remote-bob");
    const uri = "https://remote.example/notes/sq-remote";
    expect(
      await bob.send({
        id: `${uri}/activity`,
        type: "Create",
        object: {
          id: uri,
          type: "Note",
          attributedTo: bob.actorUri,
          content: "<p>quote me</p>",
          published: "2026-11-01T00:00:00.000Z",
          to: [PUBLIC],
          cc: [`${bob.actorUri}/followers`],
          interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
        },
      }),
    ).toBe(202);
    const quotedId = read(
      z.object({ id: z.string() }),
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?").bind(uri).first(),
    ).id;

    await scheduleQuote(email, quotedId, "later, about bob");
    const requestsBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbound_activities WHERE account_id = ? AND kind = 'QuoteRequest'",
    )
      .bind(alice.id)
      .first();
    expect(read(z.object({ n: z.number() }), requestsBefore).n).toBe(0);

    await publishDue();

    const [published] = await statusesOf(email, alice.id);
    expect(published?.quote).toEqual({ state: "pending", quoted_status: null });
    const request = read(
      z.object({ payload_json: z.string() }),
      await env.DB.prepare(
        "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'QuoteRequest'",
      )
        .bind(alice.id)
        .first(),
    );
    const body = read(
      z.object({ type: z.literal("QuoteRequest"), object: z.string() }),
      JSON.parse(request.payload_json),
    );
    expect(body.object).toBe(uri);
  });

  it("drops a scheduled quote whose quoted status was deleted before it was due", async () => {
    const author = "sq-deleted-author@example.com";
    const quoter = "sq-deleted-quoter@example.com";
    const quoterAccount = await signedInAccount(quoter);
    const original = await postStatus(author, { status: "soon gone" });
    await scheduleQuote(quoter, original.id, "quoting the gone");

    const deleted = await json(`/api/v1/statuses/${original.id}`, {
      method: "DELETE",
      headers: await authHeaders(author),
    });
    expect(deleted.status).toBe(200);
    await publishDue();

    expect(await statusesOf(quoter, quoterAccount.id)).toEqual([]);
    expect(await scheduledCount(quoterAccount.id)).toBe(0);
  });

  it("drops a scheduled quote when the quoted status's policy no longer allows it", async () => {
    const author = "sq-policy-author@example.com";
    const quoter = "sq-policy-quoter@example.com";
    const quoterAccount = await signedInAccount(quoter);
    const original = await postStatus(author, { status: "quotable for now" });
    await scheduleQuote(quoter, original.id, "quoting while allowed");

    const edited = await send(author, "PUT", `/api/v1/statuses/${original.id}`, {
      status: "quotable for now",
      quote_approval_policy: "nobody",
    });
    expect(edited.status).toBe(200);
    await publishDue();

    expect(await statusesOf(quoter, quoterAccount.id)).toEqual([]);
    expect(await scheduledCount(quoterAccount.id)).toBe(0);
  });
});
