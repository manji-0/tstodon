import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
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

const QuoteSchema = z.object({
  state: z.string(),
  quoted_status: z.object({ id: z.string() }).nullable(),
});

const StatusSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  visibility: z.string(),
  quotes_count: z.number(),
  quote: QuoteSchema.nullable(),
});

const post = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });

const create = async (email: string, body: Record<string, unknown>): Promise<StatusDocument> => {
  const response = await post(email, body);
  if (response.status !== 200) {
    throw new Error(`create failed ${response.status}: ${JSON.stringify(response.body)}`);
  }
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body);
};

type StatusDocument = z.infer<typeof StatusSchema>;

const getStatus = async (id: string, email: string): Promise<StatusDocument> => {
  const response = await json(`/api/v1/statuses/${id}`, { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body);
};

const account = async (email: string): Promise<{ id: string; username: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  return read(z.object({ id: z.string().min(1), username: z.string().min(1) }), response.body);
};

const accountId = async (email: string): Promise<string> => (await account(email)).id;

describe("quote posts", () => {
  it("creates an accepted quote with the inline link and counts it", async () => {
    const author = "quote-author@example.com";
    const quoter = "quote-quoter@example.com";
    const original = await create(author, { status: "the original words" });

    const quoting = await create(quoter, {
      status: "my take",
      quoted_status_id: original.id,
    });
    expect(quoting.quote?.state).toBe("accepted");
    expect(quoting.quote?.quoted_status?.id).toBe(original.id);
    expect(quoting.content).toContain("quote-inline");
    expect(quoting.quotes_count).toBe(0);

    const refreshed = await getStatus(original.id, quoter);
    expect(refreshed.quotes_count).toBe(1);

    const quotes = await json(`/api/v1/statuses/${original.id}/quotes`, {
      headers: await auth(quoter),
    });
    expect(quotes.status).toBe(200);
    const listed = read(z.array(StatusSchema), quotes.body);
    expect(listed.map((status) => status.id)).toContain(quoting.id);
    expect(listed[0]?.quote?.quoted_status?.id).toBe(original.id);

    // A quote cannot carry media or a poll.
    const withPoll = await post(quoter, {
      status: "quoted with poll",
      quoted_status_id: original.id,
      poll: { options: ["a", "b"], expires_in: 3600 },
    });
    expect(withPoll.status).toBe(422);

    // It cannot be scheduled either.
    const scheduled = await post(quoter, {
      status: "quoted later",
      quoted_status_id: original.id,
      scheduled_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    expect(scheduled.status).toBe(422);
  });

  it("enforces a nobody policy and allows the author to quote themselves", async () => {
    const author = "quote-policy-author@example.com";
    const other = "quote-policy-other@example.com";
    const restricted = await create(author, {
      status: "do not quote",
      quote_approval_policy: "nobody",
    });

    const denied = await post(other, {
      status: "trying anyway",
      quoted_status_id: restricted.id,
    });
    expect(denied.status).toBe(404);

    const self = await create(author, {
      status: "quoting myself",
      quoted_status_id: restricted.id,
    });
    expect(self.quote?.state).toBe("accepted");
  });

  it("allows only followers under a followers policy", async () => {
    const author = "quote-followers-author@example.com";
    const fan = "quote-followers-fan@example.com";
    const stranger = "quote-followers-stranger@example.com";
    const restricted = await create(author, {
      status: "followers may quote",
      quote_approval_policy: "followers",
    });

    const strangerQuote = await post(stranger, {
      status: "not a follower",
      quoted_status_id: restricted.id,
    });
    expect(strangerQuote.status).toBe(404);

    const followed = await json(`/api/v1/accounts/${await accountId(author)}/follow`, {
      method: "POST",
      headers: await auth(fan),
    });
    expect(followed.status).toBe(200);

    const fanQuote = await create(fan, {
      status: "a follower quotes",
      quoted_status_id: restricted.id,
    });
    expect(fanQuote.quote?.state).toBe("accepted");
  });

  it("clamps a quote of a followers-only status to followers-only", async () => {
    const author = "quote-clamp-author@example.com";
    const other = "quote-clamp-other@example.com";
    const privateStatus = await create(author, {
      status: "followers only words",
      visibility: "private",
    });

    // A followers-only post is not quotable by anyone else.
    const denied = await post(other, {
      status: "quoting a private post",
      quoted_status_id: privateStatus.id,
    });
    expect(denied.status).toBe(404);

    // Its author may quote it, and the quote cannot be wider than the original.
    const clamped = await create(author, {
      status: "quoting my private post",
      visibility: "public",
      quoted_status_id: privateStatus.id,
    });
    expect(clamped.visibility).toBe("private");
    expect(clamped.quote?.state).toBe("accepted");
  });

  it("revokes a quote on the quoted author's request", async () => {
    const author = "quote-revoke-author@example.com";
    const quoter = "quote-revoke-quoter@example.com";
    const original = await create(author, { status: "revocable" });
    const quoting = await create(quoter, {
      status: "about to be revoked",
      quoted_status_id: original.id,
    });
    expect((await getStatus(original.id, author)).quotes_count).toBe(1);

    // Someone else cannot revoke it.
    const forbidden = await json(`/api/v1/statuses/${original.id}/quotes/${quoting.id}/revoke`, {
      method: "POST",
      headers: await auth(quoter),
    });
    expect(forbidden.status).toBe(403);

    const revoked = await json(`/api/v1/statuses/${original.id}/quotes/${quoting.id}/revoke`, {
      method: "POST",
      headers: await auth(author),
    });
    expect(revoked.status).toBe(200);
    const document = read(StatusSchema, revoked.body);
    expect(document.id).toBe(quoting.id);
    expect(document.quote?.state).toBe("revoked");
    expect(document.quote?.quoted_status).toBeNull();

    expect((await getStatus(original.id, author)).quotes_count).toBe(0);
    const listed = await json(`/api/v1/statuses/${original.id}/quotes`, {
      headers: await auth(author),
    });
    expect(read(z.array(StatusSchema), listed.body)).toEqual([]);
  });

  it("reports a deleted original as the quote state", async () => {
    const author = "quote-delete-author@example.com";
    const quoter = "quote-delete-quoter@example.com";
    const original = await create(author, { status: "will be deleted" });
    const quoting = await create(quoter, {
      status: "still here",
      quoted_status_id: original.id,
    });

    const deleted = await json(`/api/v1/statuses/${original.id}`, {
      method: "DELETE",
      headers: await auth(author),
    });
    expect(deleted.status).toBe(200);

    const after = await getStatus(quoting.id, quoter);
    expect(after.quote?.state).toBe("deleted");
    expect(after.quote?.quoted_status).toBeNull();
  });

  it("changes the policy on edit", async () => {
    const author = "quote-edit-author@example.com";
    const other = "quote-edit-other@example.com";
    const original = await create(author, { status: "quotable until edited" });

    const edited = await json(`/api/v1/statuses/${original.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(author)) },
      body: JSON.stringify({ quote_approval_policy: "nobody" }),
    });
    expect(edited.status).toBe(200);

    const denied = await post(other, {
      status: "no longer allowed",
      quoted_status_id: original.id,
    });
    expect(denied.status).toBe(404);

    const allowedAgain = await json(`/api/v1/statuses/${original.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(author)) },
      body: JSON.stringify({ quote_approval_policy: "public" }),
    });
    expect(allowedAgain.status).toBe(200);
    const accepted = await create(other, {
      status: "allowed again",
      quoted_status_id: original.id,
    });
    expect(accepted.quote?.state).toBe("accepted");
  });

  it("sends the quoted status in the ActivityPub Note", async () => {
    const author = "quote-ap-author@example.com";
    const quotter = "quote-ap-quotter@example.com";
    const quotterAccount = await account(quotter);
    const original = await create(author, { status: "ap original" });
    const quoting = await create(quotter, {
      status: "ap take",
      quoted_status_id: original.id,
    });

    // The queued Create carries the FEP-044f `quote` properties.
    const row = await env.DB.prepare(
      "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Create' ORDER BY rowid DESC LIMIT 1",
    )
      .bind(quotterAccount.id)
      .first<{ payload_json: string }>();
    expect(row).not.toBeNull();
    const payload = JSON.parse(row?.payload_json ?? "{}") as {
      object?: Record<string, unknown>;
    };
    const quotedUri = String(payload.object?.quote);
    expect(quotedUri).toContain(original.id);
    expect(payload.object?.quote_uri).toBe(quotedUri);
    expect(payload.object?._misskey_quote).toBe(quotedUri);
    expect(Array.isArray(payload.object?.["@context"])).toBe(true);

    // The actor's status document (what a remote instance fetches) says the same.
    const note = await json(`/users/${quotterAccount.username}/statuses/${quoting.id}`);
    expect(note.status).toBe(200);
    const document = read(
      z.object({
        quote: z.string(),
        quote_uri: z.string(),
        _misskey_quote: z.string(),
      }),
      note.body,
    );
    expect(document.quote).toBe(quotedUri);

    // After a revoke the note no longer points at the original.
    const revoked = await json(`/api/v1/statuses/${original.id}/quotes/${quoting.id}/revoke`, {
      method: "POST",
      headers: await auth(author),
    });
    expect(revoked.status).toBe(200);
    const afterRevoke = await json(`/users/${quotterAccount.username}/statuses/${quoting.id}`);
    expect(
      read(z.object({ quote: z.string().optional().nullable() }), afterRevoke.body).quote,
    ).toBeUndefined();
  });

  it("notifies the quoted author and the quoter on an edit", async () => {
    const author = "quote-notify-author@example.com";
    const quoter = "quote-notify-quoter@example.com";
    const original = await create(author, { status: "quote me" });
    const quoting = await create(quoter, {
      status: "quoted you",
      quoted_status_id: original.id,
    });

    const NotificationSchema = z.object({
      type: z.string(),
      status: z.object({ id: z.string() }).nullable(),
    });
    const notifications = async (email: string) => {
      const response = await json("/api/v1/notifications", { headers: await auth(email) });
      expect(response.status).toBe(200);
      return read(z.array(NotificationSchema), response.body);
    };

    const quoteNotification = (await notifications(author)).find(
      (notification) => notification.type === "quote",
    );
    expect(quoteNotification?.status?.id).toBe(quoting.id);

    // A self-quote does not notify its own author.
    await create(author, { status: "self quote", quoted_status_id: original.id });
    const selfQuotes = (await notifications(author)).filter(
      (notification) => notification.type === "quote" && notification.status?.id !== quoting.id,
    );
    expect(selfQuotes).toEqual([]);

    // Editing the original tells the person who quoted it, with their quote attached.
    const edited = await json(`/api/v1/statuses/${original.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(author)) },
      body: JSON.stringify({ status: "quote me, edited" }),
    });
    expect(edited.status).toBe(200);
    const updateNotification = (await notifications(quoter)).find(
      (notification) => notification.type === "quoted_update",
    );
    expect(updateNotification?.status?.id).toBe(quoting.id);
  });
});
