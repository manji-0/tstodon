import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { deliveredCreate } from "../test/delivery-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

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

const canQuotePublic = { interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } } };

const remoteNote = async (
  author: Remote,
  slug: string,
  extra: Record<string, unknown> = canQuotePublic,
): Promise<{ uri: string; id: string }> => {
  const uri = `https://remote.example/notes/${slug}`;
  const object = {
    id: uri,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-11-01T00:00:00.000Z",
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
    ...extra,
  };
  expect(await author.send({ id: `${uri}/activity`, type: "Create", object })).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .first();
  return { uri, id: read(z.object({ id: z.string() }), row).id };
};

const postQuote = (email: string, quotedId: string, extra: Record<string, unknown> = {}) =>
  authHeaders(email).then((headers) =>
    json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ status: "quoting", quoted_status_id: quotedId, ...extra }),
    }),
  );

const QuoteDocumentSchema = z.object({
  id: z.string(),
  quote: z.object({
    state: z.string(),
    quoted_status: z.object({ id: z.string() }).nullable(),
  }),
});

const quoteOf = async (email: string, statusId: string) => {
  const response = await json(`/api/v1/statuses/${statusId}`, {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(QuoteDocumentSchema, response.body).quote;
};

const PayloadRowsSchema = z.array(z.object({ id: z.string(), payload_json: z.string() }));

/** The account's queued activities of one kind, oldest first, parsed. */
const queued = async (accountId: string, kind: string) => {
  const { results } = await env.DB.prepare(
    "SELECT id, payload_json FROM outbound_activities WHERE account_id = ? AND kind = ? ORDER BY rowid",
  )
    .bind(accountId, kind)
    .all();
  return read(PayloadRowsSchema, results).map((row) => ({
    id: row.id,
    payload: read(z.record(z.string(), z.unknown()), JSON.parse(row.payload_json)),
  }));
};

const deliveryInboxes = async (activityId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL",
  )
    .bind(activityId)
    .all();
  return read(z.array(z.object({ inbox_url: z.string() })), results).map((row) => row.inbox_url);
};

const QuoteRequestSchema = z.object({
  id: z.string(),
  type: z.literal("QuoteRequest"),
  actor: z.string(),
  object: z.string(),
  instrument: z.object({ id: z.string(), quote: z.string(), cc: z.array(z.string()) }),
});

/** Alice (local) quotes a public note of Bob (remote) that anyone may quote. */
const quoteBob = async (slug: string) => {
  const email = `${slug}-alice@example.com`;
  const alice = await signedInAccount(email);
  const bob = await remoteActor(`${slug}-bob`);
  const bobNote = await remoteNote(bob, slug);
  const posted = await postQuote(email, bobNote.id);
  expect(posted.status).toBe(200);
  const quotingId = read(QuoteDocumentSchema, posted.body).id;
  const [request] = await queued(alice.id, "QuoteRequest");
  if (!request) {
    throw new Error("no QuoteRequest was queued");
  }
  return {
    email,
    alice,
    bob,
    bobNote,
    quotingId,
    noteUri: `https://example.com/users/${alice.username}/statuses/${quotingId}`,
    request: { ...request, body: read(QuoteRequestSchema, request.payload) },
    posted: read(QuoteDocumentSchema, posted.body),
  };
};

describe("quoting a remote status", () => {
  it("posts a pending quote and asks the quoted author with a QuoteRequest", async () => {
    const quote = await quoteBob("rq-request");

    expect(quote.posted.quote).toEqual({ state: "pending", quoted_status: null });
    const { body } = quote.request;
    expect(body.actor).toBe(`https://example.com/users/${quote.alice.username}`);
    expect(body.id).toBe(`${body.actor}/quote_requests/${body.id.split("/").at(-1)}`);
    expect(body.object).toBe(quote.bobNote.uri);
    expect(body.instrument.id).toBe(quote.noteUri);
    expect(body.instrument.quote).toBe(quote.bobNote.uri);
    expect(await deliveryInboxes(quote.request.id)).toEqual([`${quote.bob.actorUri}/inbox`]);

    const created = await deliveredCreate(quote.alice.id, quote.noteUri);
    if (!created) {
      throw new Error("no Create was queued");
    }
    expect(created.activity.object.cc).toContain(quote.bob.actorUri);
    // The quoted author is in `cc`, so the Create reaches its inbox too.
    expect(created.inboxes).toContain(`${quote.bob.actorUri}/inbox`);
    const [createRow] = await queued(quote.alice.id, "Create");
    const createObject = read(
      z.object({ object: z.record(z.string(), z.unknown()) }),
      createRow?.payload,
    ).object;
    expect(createObject.quote).toBe(quote.bobNote.uri);
    expect(createObject).not.toHaveProperty("quoteAuthorization");
  });

  it("accepts the quote with the stamp an Accept names and federates it in an Update", async () => {
    const quote = await quoteBob("rq-accept");
    const stamp = `${quote.bob.actorUri}/stamps/1`;

    expect(
      await quote.bob.send({
        id: `${quote.bob.actorUri}#accepts/1`,
        type: "Accept",
        object: { id: quote.request.body.id, type: "QuoteRequest" },
        result: stamp,
      }),
    ).toBe(202);

    expect(await quoteOf(quote.email, quote.quotingId)).toEqual({
      state: "accepted",
      quoted_status: expect.objectContaining({ id: quote.bobNote.id }),
    });
    const updates = await queued(quote.alice.id, "Update");
    expect(
      updates.map(
        (update) =>
          read(z.object({ object: z.record(z.string(), z.unknown()) }), update.payload).object,
      ),
    ).toContainEqual(
      expect.objectContaining({
        id: quote.noteUri,
        quote: quote.bobNote.uri,
        quoteAuthorization: stamp,
      }),
    );
  });

  it("keeps the quote pending for a stamp on another host or an Accept by someone else", async () => {
    const quote = await quoteBob("rq-forged");
    const carol = await remoteActor("rq-forged-carol");

    expect(
      await quote.bob.send({
        id: `${quote.bob.actorUri}#accepts/forged-host`,
        type: "Accept",
        object: quote.request.body.id,
        result: "https://elsewhere.example/stamps/1",
      }),
    ).toBe(202);
    expect(
      await carol.send({
        id: `${carol.actorUri}#accepts/forged-signer`,
        type: "Accept",
        object: quote.request.body.id,
        result: `${carol.actorUri}/stamps/1`,
      }),
    ).toBe(202);

    expect((await quoteOf(quote.email, quote.quotingId)).state).toBe("pending");
    expect(await queued(quote.alice.id, "Update")).toEqual([]);
  });

  it("rejects the quote on a Reject, and revokes it on a Reject after an Accept", async () => {
    const rejected = await quoteBob("rq-reject");
    expect(
      await rejected.bob.send({
        id: `${rejected.bob.actorUri}#rejects/1`,
        type: "Reject",
        object: rejected.request.body.id,
      }),
    ).toBe(202);
    expect(await quoteOf(rejected.email, rejected.quotingId)).toEqual({
      state: "rejected",
      quoted_status: null,
    });

    const revoked = await quoteBob("rq-reject-late");
    expect(
      await revoked.bob.send({
        id: `${revoked.bob.actorUri}#accepts/1`,
        type: "Accept",
        object: revoked.request.body.id,
        result: `${revoked.bob.actorUri}/stamps/1`,
      }),
    ).toBe(202);
    expect(
      await revoked.bob.send({
        id: `${revoked.bob.actorUri}#rejects/1`,
        type: "Reject",
        object: revoked.request.body.id,
      }),
    ).toBe(202);
    expect((await quoteOf(revoked.email, revoked.quotingId)).state).toBe("revoked");
  });

  it("revokes the quote when the quoted author deletes the stamp, keeping the note", async () => {
    const quote = await quoteBob("rq-stamp-delete");
    const stamp = `${quote.bob.actorUri}/stamps/1`;
    expect(
      await quote.bob.send({
        id: `${quote.bob.actorUri}#accepts/1`,
        type: "Accept",
        object: quote.request.body.id,
        result: stamp,
      }),
    ).toBe(202);

    expect(
      await quote.bob.send({
        id: `${stamp}#delete`,
        type: "Delete",
        object: { id: stamp, type: "QuoteAuthorization" },
      }),
    ).toBe(202);

    expect(await quoteOf(quote.email, quote.quotingId)).toEqual({
      state: "revoked",
      quoted_status: null,
    });
    expect(
      (
        await json(`/api/v1/statuses/${quote.bobNote.id}`, {
          headers: await authHeaders(quote.email),
        })
      ).status,
    ).toBe(200);
  });

  it("refuses a note whose author lets nobody quote it with Mastodon's 404", async () => {
    const email = "rq-nobody-alice@example.com";
    const bob = await remoteActor("rq-nobody-bob");
    const bobNote = await remoteNote(bob, "rq-nobody", {});

    expect(await postQuote(email, bobNote.id)).toEqual({
      status: 404,
      body: expect.objectContaining({
        error: "The post you are trying to quote does not appear to exist.",
      }),
    });
  });

  it("refuses a followers-only note with 422, even to a follower", async () => {
    const email = "rq-private-alice@example.com";
    const alice = await signedInAccount(email);
    const bob = await remoteActor("rq-private-bob");
    const followed = await json(`/api/v1/accounts/${RemoteAccountId.encode(bob.actorUri)}/follow`, {
      method: "POST",
      headers: await authHeaders(email),
    });
    expect(followed.status).toBe(200);
    const follow = await env.DB.prepare(
      "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
    )
      .bind(alice.id, bob.actorUri)
      .first();
    expect(
      await bob.send({
        id: `${bob.actorUri}#accepts/follow`,
        type: "Accept",
        object: read(z.object({ follow_activity_id: z.string() }), follow).follow_activity_id,
      }),
    ).toBe(202);
    const bobNote = await remoteNote(bob, "rq-private", {
      ...canQuotePublic,
      to: [`${bob.actorUri}/followers`],
      cc: [],
    });

    const posted = await postQuote(email, bobNote.id);
    expect(posted.status).toBe(422);
    expect(posted.body).toEqual(expect.objectContaining({ kind: "QuoteNotAllowed" }));
  });
});
