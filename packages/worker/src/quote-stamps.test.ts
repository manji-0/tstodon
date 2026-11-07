import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(new URL(path, "https://example.com"), init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const account = async (email: string): Promise<{ id: string; username: string }> =>
  read(
    z.object({ id: z.string().min(1), username: z.string().min(1) }),
    (await json("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })).body,
  );

const create = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const revoke = async (email: string, quotedId: string, quotingId: string): Promise<number> =>
  (
    await json(`/api/v1/statuses/${quotedId}/quotes/${quotingId}/revoke`, {
      method: "POST",
      headers: await authHeaders(email),
    })
  ).status;

const activityJson = { headers: { accept: "application/activity+json" } };

const NoteSchema = z.object({ quote: z.string(), quoteAuthorization: z.string() });

/** `quoter` quotes a public status of `author`; both are local accounts. */
const localQuote = async (author: string, quoter: string) => {
  const alice = await account(author);
  const bob = await account(quoter);
  const quotedId = await create(author, { status: "stamp me" });
  const quotingId = await create(quoter, { status: "quoting", quoted_status_id: quotedId });
  const aliceUri = `https://example.com/users/${alice.username}`;
  const bobUri = `https://example.com/users/${bob.username}`;
  return {
    alice,
    bob,
    quotedId,
    quotingId,
    quotedUri: `${aliceUri}/statuses/${quotedId}`,
    quotingUri: `${bobUri}/statuses/${quotingId}`,
    aliceUri,
  };
};

const stampContext = [
  "https://www.w3.org/ns/activitystreams",
  {
    gts: "https://gotosocial.org/ns#",
    QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
    interactingObject: { "@id": "gts:interactingObject", "@type": "@id" },
    interactionTarget: { "@id": "gts:interactionTarget", "@type": "@id" },
  },
];

describe("quote stamps for local statuses", () => {
  it("serves the stamp an accepted local quote names in its note", async () => {
    const quote = await localQuote("stamp-alice@example.com", "stamp-bob@example.com");

    const note = await json(
      `/users/${quote.bob.username}/statuses/${quote.quotingId}`,
      activityJson,
    );
    expect(note.status).toBe(200);
    const { quote: quoted, quoteAuthorization } = read(NoteSchema, note.body);
    expect(quoted).toBe(quote.quotedUri);
    expect(quoteAuthorization).toMatch(
      new RegExp(`^${quote.aliceUri}/quote_authorizations/[^/]+$`),
    );
    expect(read(z.object({ "@context": z.array(z.unknown()) }), note.body)["@context"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          quoteAuthorization: {
            "@id": "https://w3id.org/fep/044f#quoteAuthorization",
            "@type": "@id",
          },
        }),
      ]),
    );

    // The queued Create carries the same stamp.
    const created = await env.DB.prepare(
      "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Create' ORDER BY rowid DESC LIMIT 1",
    )
      .bind(quote.bob.id)
      .first();
    const createPayload = read(z.object({ payload_json: z.string() }), created).payload_json;
    expect(
      read(z.object({ object: NoteSchema }), JSON.parse(createPayload)).object.quoteAuthorization,
    ).toBe(quoteAuthorization);

    const stampResponse = await SELF.fetch(
      new URL(new URL(quoteAuthorization).pathname, "https://example.com"),
      activityJson,
    );
    expect(stampResponse.headers.get("cache-control")).toBe("max-age=30, public");
    const stamp = { status: stampResponse.status, body: await stampResponse.json() };
    expect(stamp.status).toBe(200);
    expect(stamp.body).toEqual({
      "@context": stampContext,
      id: quoteAuthorization,
      type: "QuoteAuthorization",
      attributedTo: quote.aliceUri,
      interactingObject: quote.quotingUri,
      interactionTarget: quote.quotedUri,
    });
  });

  it("answers 404 for another account's path or an unknown id", async () => {
    const quote = await localQuote("stamp-path-alice@example.com", "stamp-path-bob@example.com");
    const note = await json(
      `/users/${quote.bob.username}/statuses/${quote.quotingId}`,
      activityJson,
    );
    const stampPath = new URL(read(NoteSchema, note.body).quoteAuthorization).pathname;

    const quoteId = stampPath.split("/").at(-1) ?? "";
    expect(
      (await json(`/users/${quote.bob.username}/quote_authorizations/${quoteId}`, activityJson))
        .status,
    ).toBe(404);
    expect(
      (
        await json(
          `/users/${quote.alice.username}/quote_authorizations/no-such-quote`,
          activityJson,
        )
      ).status,
    ).toBe(404);
    expect((await json(`/users/nobody-here/quote_authorizations/${quoteId}`)).status).toBe(404);
  });

  it("withdraws the stamp with a Delete to both authors' remote followers on revoke", async () => {
    const quote = await localQuote(
      "stamp-revoke-alice@example.com",
      "stamp-revoke-bob@example.com",
    );
    const aliceFollower = await remoteActor("stamp-carol", "carol.example");
    const bobFollower = await remoteActor("stamp-dave", "dave.example");
    for (const [follower, username] of [
      [aliceFollower, quote.alice.username],
      [bobFollower, quote.bob.username],
    ] as const) {
      expect(
        await follower.send({
          id: `${follower.actorUri}/follows/1`,
          type: "Follow",
          object: `https://example.com/users/${username}`,
        }),
      ).toBe(202);
    }
    const note = await json(
      `/users/${quote.bob.username}/statuses/${quote.quotingId}`,
      activityJson,
    );
    const stampUri = read(NoteSchema, note.body).quoteAuthorization;

    expect(await revoke("stamp-revoke-alice@example.com", quote.quotedId, quote.quotingId)).toBe(
      200,
    );

    expect((await json(new URL(stampUri).pathname, activityJson)).status).toBe(404);
    const row = await env.DB.prepare(
      "SELECT id, payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Delete'",
    )
      .bind(quote.alice.id)
      .first();
    const queued = read(z.object({ id: z.string(), payload_json: z.string() }), row);
    expect(JSON.parse(queued.payload_json)).toEqual({
      "@context": stampContext,
      id: `${stampUri}#delete`,
      type: "Delete",
      actor: quote.aliceUri,
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      object: {
        id: stampUri,
        type: "QuoteAuthorization",
        attributedTo: quote.aliceUri,
        interactingObject: quote.quotingUri,
        interactionTarget: quote.quotedUri,
      },
    });
    const { results } = await env.DB.prepare(
      "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
    )
      .bind(queued.id)
      .all();
    expect(read(z.array(z.object({ inbox_url: z.string() })), results)).toEqual([
      { inbox_url: `${aliceFollower.actorUri}/inbox` },
      { inbox_url: `${bobFollower.actorUri}/inbox` },
    ]);

    // The revoked note still names the quote, without its stamp.
    const after = await json(
      `/users/${quote.bob.username}/statuses/${quote.quotingId}`,
      activityJson,
    );
    expect(
      read(z.object({ quote: z.string(), quoteAuthorization: z.string().optional() }), after.body),
    ).toEqual({ quote: quote.quotedUri });
  });

  it("tells the quoting author's stream that the quote was revoked", async () => {
    const email = "stamp-stream-bob@example.com";
    const quote = await localQuote("stamp-stream-alice@example.com", email);
    const socket = await openStream({ email, query: "?stream=user" });

    expect(await revoke("stamp-stream-alice@example.com", quote.quotedId, quote.quotingId)).toBe(
      200,
    );

    expect(await socket.next()).toMatchObject({ event: "status.update" });
    socket.close();
  });
});
