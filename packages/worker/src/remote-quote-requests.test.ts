import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(new URL(path, "https://example.com"), init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const send = async (email: string, path: string, body: Record<string, unknown> = {}) =>
  json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });

const IdSchema = z.object({ id: z.string() });

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

const remoteStatusId = async (objectUri: string): Promise<string> =>
  read(
    IdSchema,
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(objectUri)
      .first(),
  ).id;

const QuoteSchema = z
  .object({ state: z.string(), quoted_status: z.object({ id: z.string() }).nullable() })
  .nullable();

const quoteOf = async (email: string, statusId: string) => {
  const response = await json(`/api/v1/statuses/${statusId}`, {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(z.object({ quote: QuoteSchema }), response.body).quote;
};

/** Alice (local) posts a status Bob (remote) quotes in a note he writes. */
const setup = async (slug: string, status: Record<string, unknown> = {}) => {
  const email = `${slug}-alice@example.com`;
  const alice = await signedInAccount(email);
  const bob = await remoteActor(`${slug}-bob`);
  const posted = await send(email, "/api/v1/statuses", { status: "quote me", ...status });
  expect(posted.status).toBe(200);
  const statusId = read(IdSchema, posted.body).id;
  const aliceUri = `https://example.com/users/${alice.username}`;
  const statusUri = `${aliceUri}/statuses/${statusId}`;
  const noteUri = `https://remote.example/notes/${slug}`;
  const note = (extra: Record<string, unknown> = {}) => ({
    id: noteUri,
    type: "Note",
    attributedTo: bob.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-11-01T00:00:00.000Z",
    to: [PUBLIC],
    cc: [`${bob.actorUri}/followers`],
    quote: statusUri,
    ...extra,
  });
  const requestId = `${bob.actorUri}/quote_requests/${slug}`;
  const request = (overrides: Record<string, unknown> = {}) =>
    bob.send({
      id: requestId,
      type: "QuoteRequest",
      object: statusUri,
      instrument: note(),
      ...overrides,
    });
  return { email, alice, bob, statusId, aliceUri, statusUri, noteUri, note, requestId, request };
};

const answersTo = async (accountId: string, kind: "Accept" | "Reject") =>
  (await queued(accountId, kind)).filter((row) =>
    schemaResult(z.object({ object: z.object({ type: z.literal("QuoteRequest") }) }))(
      row.payload,
    ).isOk(),
  );

/** The account's answers to quote requests, leaving out answers to follows. */
const answers = async (accountId: string) => ({
  accepts: await answersTo(accountId, "Accept"),
  rejects: await answersTo(accountId, "Reject"),
});

const notificationsOf = async (email: string) =>
  read(
    z.array(z.object({ type: z.string(), status: IdSchema.nullable().optional() })),
    (await json("/api/v1/notifications", { headers: await authHeaders(email) })).body,
  );

const follow = (bob: Remote, aliceUri: string) =>
  bob.send({ id: `${bob.actorUri}#follows/1`, type: "Follow", object: aliceUri });

describe("answering a remote QuoteRequest for a local status", () => {
  it("accepts under the default public policy with the stamp as result", async () => {
    const quote = await setup("rqr-accept");
    expect(await quote.request()).toBe(202);

    const { accepts, rejects } = await answers(quote.alice.id);
    expect(rejects).toEqual([]);
    expect(accepts).toHaveLength(1);
    const [accept] = accepts;
    if (!accept) {
      throw new Error("no Accept was queued");
    }
    const result = read(z.object({ result: z.string() }), accept.payload).result;
    const quoteId = result.split("/").at(-1);
    expect(result).toBe(`${quote.aliceUri}/quote_authorizations/${quoteId}`);
    expect(accept.payload).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        { QuoteRequest: "https://w3id.org/fep/044f#QuoteRequest" },
      ],
      id: `${quote.aliceUri}#accepts/quote_requests/${quoteId}`,
      type: "Accept",
      actor: quote.aliceUri,
      result,
      object: {
        type: "QuoteRequest",
        id: quote.requestId,
        actor: quote.bob.actorUri,
        object: quote.statusUri,
        instrument: quote.noteUri,
      },
    });
    expect(await deliveryInboxes(accept.id)).toEqual([`${quote.bob.actorUri}/inbox`]);

    const stamp = await json(new URL(result).pathname, {
      headers: { accept: "application/activity+json" },
    });
    expect(stamp.status).toBe(200);
    expect(stamp.body).toEqual(
      expect.objectContaining({
        id: result,
        type: "QuoteAuthorization",
        attributedTo: quote.aliceUri,
        interactingObject: quote.noteUri,
        interactionTarget: quote.statusUri,
      }),
    );
  });

  it("notifies the author, lists and counts the quote, and renders it on the remote note", async () => {
    const quote = await setup("rqr-render");
    expect(await quote.request()).toBe(202);
    const bobNoteId = await remoteStatusId(quote.noteUri);

    expect(await notificationsOf(quote.email)).toContainEqual(
      expect.objectContaining({
        type: "quote",
        status: expect.objectContaining({ id: bobNoteId }),
      }),
    );
    const listed = await json(`/api/v1/statuses/${quote.statusId}/quotes`, {
      headers: await authHeaders(quote.email),
    });
    expect(listed.status).toBe(200);
    expect(read(z.array(IdSchema), listed.body).map((status) => status.id)).toEqual([bobNoteId]);
    const alice = await json(`/api/v1/statuses/${quote.statusId}`, {
      headers: await authHeaders(quote.email),
    });
    expect(read(z.object({ quotes_count: z.number() }), alice.body).quotes_count).toBe(1);
    expect(await quoteOf(quote.email, bobNoteId)).toEqual({
      state: "accepted",
      quoted_status: expect.objectContaining({ id: quote.statusId }),
    });
  });

  it.each([
    ["a direct note that does not address the author", "direct", { to: [], cc: [] }],
    ["a followers-only note of an author they do not follow", "private", {}],
    ["a followers-only note of an author they follow", "followed", {}],
  ])(
    "accepts a quote from %s and shows it to the quoted author",
    async (_label, slug, audience) => {
      const quote = await setup(`rqr-audience-${slug}`);
      if (slug === "followed") {
        await env.DB.prepare(
          `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
           VALUES (?, ?, ?, ?, 'Accepted')`,
        )
          .bind(slug, quote.alice.id, quote.bob.actorUri, `https://example.com/follows/${slug}`)
          .run();
      }
      expect(
        await quote.request({
          instrument: quote.note({ to: [`${quote.bob.actorUri}/followers`], cc: [], ...audience }),
        }),
      ).toBe(202);

      expect((await answers(quote.alice.id)).accepts).toHaveLength(1);
      const notifications = await notificationsOf(quote.email);
      expect(notifications.some((n) => n.type === "quote")).toBe(true);
      expect(notifications.some((n) => n.type === "mention")).toBe(false);
      const bobNoteId = await remoteStatusId(quote.noteUri);
      expect(await quoteOf(quote.email, bobNoteId)).toEqual({
        state: "accepted",
        quoted_status: expect.objectContaining({ id: quote.statusId }),
      });
      expect((await json(`/api/v1/statuses/${bobNoteId}`)).status).toBe(404);
    },
  );

  it("rejects under a nobody policy and notifies nobody", async () => {
    const quote = await setup("rqr-nobody", { quote_approval_policy: "nobody" });
    expect(await quote.request()).toBe(202);

    const { accepts, rejects } = await answers(quote.alice.id);
    expect(accepts).toEqual([]);
    expect(rejects).toHaveLength(1);
    const reject = rejects[0]?.payload;
    expect(reject).toEqual(
      expect.objectContaining({
        type: "Reject",
        actor: quote.aliceUri,
        id: expect.stringMatching(new RegExp(`^${quote.aliceUri}#rejects/quote_requests/[^/]+$`)),
        object: {
          type: "QuoteRequest",
          id: quote.requestId,
          actor: quote.bob.actorUri,
          object: quote.statusUri,
          instrument: quote.noteUri,
        },
      }),
    );
    expect(reject).not.toHaveProperty("result");
    expect((await notificationsOf(quote.email)).map((n) => n.type)).not.toContain("quote");
  });

  it("under a followers policy rejects a stranger and accepts a remote follower", async () => {
    const stranger = await setup("rqr-followers-no", { quote_approval_policy: "followers" });
    expect(await stranger.request()).toBe(202);
    expect((await answers(stranger.alice.id)).rejects).toHaveLength(1);

    const follower = await setup("rqr-followers-yes", { quote_approval_policy: "followers" });
    expect(await follow(follower.bob, follower.aliceUri)).toBe(202);
    expect(await follower.request()).toBe(202);
    const { accepts, rejects } = await answers(follower.alice.id);
    expect(rejects).toEqual([]);
    expect(accepts).toHaveLength(1);
  });

  it("does not answer for a followers-only status", async () => {
    const quote = await setup("rqr-private", { visibility: "private" });
    expect(await follow(quote.bob, quote.aliceUri)).toBe(202);
    expect(await quote.request()).toBe(202);
    expect(await answers(quote.alice.id)).toEqual({ accepts: [], rejects: [] });
  });

  it("does not answer a request whose id is on another host than its actor", async () => {
    const quote = await setup("rqr-forged-id");
    expect(
      await quote.request({ id: "https://elsewhere.example/quote_requests/rqr-forged-id" }),
    ).toBe(202);
    expect(await answers(quote.alice.id)).toEqual({ accepts: [], rejects: [] });
  });

  it("drops without an answer a request reusing another actor's request id", async () => {
    const quote = await setup("rqr-reused-id");
    expect(await quote.request()).toBe(202);
    const eve = await remoteActor("rqr-reused-id-eve");
    const eveNote = `https://remote.example/notes/rqr-reused-id-eve`;
    // As if both deliveries had passed the inbox's duplicate check at once.
    await env.DB.prepare("DELETE FROM inbox_activities WHERE activity_id = ?")
      .bind(quote.requestId)
      .run();

    expect(
      await eve.send({
        id: quote.requestId,
        type: "QuoteRequest",
        object: quote.statusUri,
        instrument: quote.note({ id: eveNote, attributedTo: eve.actorUri }),
      }),
    ).toBe(202);

    expect(await answers(quote.alice.id)).toEqual({
      accepts: [expect.anything()],
      rejects: [],
    });
    expect(await quoteOf(quote.email, await remoteStatusId(eveNote))).toEqual({
      state: "pending",
      quoted_status: null,
    });
  });

  it("publishes a conversation update for a direct quote", async () => {
    const quote = await setup("rqr-direct-stream");
    const socket = await openStream({ email: quote.email, query: "?stream=direct" });

    expect(await quote.request({ instrument: quote.note({ to: [], cc: [] }) })).toBe(202);

    expect(await socket.next()).toMatchObject({ stream: ["direct"], event: "conversation" });
    socket.close();
  });

  it("rejects a request from an actor the author blocks", async () => {
    const quote = await setup("rqr-blocked");
    const blocked = await send(
      quote.email,
      `/api/v1/accounts/${RemoteAccountId.encode(quote.bob.actorUri)}/block`,
    );
    expect(blocked.status).toBe(200);
    expect(await quote.request()).toBe(202);

    const { accepts, rejects } = await answers(quote.alice.id);
    expect(accepts).toEqual([]);
    expect(rejects).toHaveLength(1);
  });
});

describe("remote notes that quote a local status", () => {
  it("shows a quote sent without a QuoteRequest as pending", async () => {
    const quote = await setup("rqr-create");
    expect(
      await quote.bob.send({
        id: `${quote.noteUri}/activity`,
        type: "Create",
        object: quote.note(),
      }),
    ).toBe(202);

    expect(await quoteOf(quote.email, await remoteStatusId(quote.noteUri))).toEqual({
      state: "pending",
      quoted_status: null,
    });
  });

  it("keeps an accepted quote through an edit and forgets it when the edit drops it", async () => {
    const quote = await setup("rqr-update");
    expect(await quote.request()).toBe(202);
    const bobNoteId = await remoteStatusId(quote.noteUri);

    expect(
      await quote.bob.send({
        id: `${quote.noteUri}#updates/1`,
        type: "Update",
        object: quote.note({ content: "<p>edited</p>", updated: "2026-11-02T00:00:00.000Z" }),
      }),
    ).toBe(202);
    expect((await quoteOf(quote.email, bobNoteId))?.state).toBe("accepted");

    const { quote: _dropped, ...unquoted } = quote.note({
      content: "<p>edited again</p>",
      updated: "2026-11-03T00:00:00.000Z",
    });
    expect(
      await quote.bob.send({ id: `${quote.noteUri}#updates/2`, type: "Update", object: unquoted }),
    ).toBe(202);
    expect(await quoteOf(quote.email, bobNoteId)).toBeNull();
    const alice = await json(`/api/v1/statuses/${quote.statusId}`, {
      headers: await authHeaders(quote.email),
    });
    expect(read(z.object({ quotes_count: z.number() }), alice.body).quotes_count).toBe(0);
  });

  it("withdraws the stamp when an edit moves an accepted quote, not when it keeps it", async () => {
    const quote = await setup("rqr-move");
    expect(await quote.request()).toBe(202);
    const bobNoteId = await remoteStatusId(quote.noteUri);
    const other = await send(quote.email, "/api/v1/statuses", { status: "quote me instead" });
    expect(other.status).toBe(200);
    const otherUri = `${quote.aliceUri}/statuses/${read(IdSchema, other.body).id}`;

    expect(
      await quote.bob.send({
        id: `${quote.noteUri}#updates/1`,
        type: "Update",
        object: quote.note({ content: "<p>edited</p>", updated: "2026-11-02T00:00:00.000Z" }),
      }),
    ).toBe(202);
    expect(await queued(quote.alice.id, "Delete")).toEqual([]);

    expect(
      await quote.bob.send({
        id: `${quote.noteUri}#updates/2`,
        type: "Update",
        object: quote.note({
          content: "<p>moved</p>",
          updated: "2026-11-03T00:00:00.000Z",
          quote: otherUri,
        }),
      }),
    ).toBe(202);
    const deletions = await queued(quote.alice.id, "Delete");
    expect(deletions.map((row) => row.payload)).toEqual([
      expect.objectContaining({
        type: "Delete",
        actor: quote.aliceUri,
        object: expect.objectContaining({
          type: "QuoteAuthorization",
          interactingObject: quote.noteUri,
          interactionTarget: quote.statusUri,
        }),
      }),
    ]);
    expect(await deliveryInboxes(deletions[0]?.id ?? "")).toEqual([`${quote.bob.actorUri}/inbox`]);
    expect(await quoteOf(quote.email, bobNoteId)).toEqual({
      state: "pending",
      quoted_status: null,
    });
  });

  it("withdraws the stamp when an edit drops an accepted quote", async () => {
    const quote = await setup("rqr-drop");
    expect(await quote.request()).toBe(202);
    const { quote: _dropped, ...unquoted } = quote.note({
      content: "<p>no quote</p>",
      updated: "2026-11-02T00:00:00.000Z",
    });

    expect(
      await quote.bob.send({ id: `${quote.noteUri}#updates/1`, type: "Update", object: unquoted }),
    ).toBe(202);

    const deletions = await queued(quote.alice.id, "Delete");
    expect(deletions.map((row) => row.payload)).toEqual([
      expect.objectContaining({
        type: "Delete",
        object: expect.objectContaining({
          interactingObject: quote.noteUri,
          interactionTarget: quote.statusUri,
        }),
      }),
    ]);
    expect(await quoteOf(quote.email, await remoteStatusId(quote.noteUri))).toBeNull();
  });

  it("sends no stamp Delete when an edit moves a quote that was never accepted", async () => {
    const quote = await setup("rqr-move-pending");
    expect(
      await quote.bob.send({
        id: `${quote.noteUri}/activity`,
        type: "Create",
        object: quote.note(),
      }),
    ).toBe(202);
    const { quote: _dropped, ...unquoted } = quote.note({
      content: "<p>no quote</p>",
      updated: "2026-11-02T00:00:00.000Z",
    });

    expect(
      await quote.bob.send({ id: `${quote.noteUri}#updates/1`, type: "Update", object: unquoted }),
    ).toBe(202);

    expect(await queued(quote.alice.id, "Delete")).toEqual([]);
  });

  it("revokes the quote with a stamp Delete sent to the quoting author's inbox", async () => {
    const quote = await setup("rqr-revoke");
    expect(await quote.request()).toBe(202);
    const bobNoteId = await remoteStatusId(quote.noteUri);

    const revoked = await send(
      quote.email,
      `/api/v1/statuses/${quote.statusId}/quotes/${bobNoteId}/revoke`,
    );
    expect(revoked.status).toBe(200);
    expect(read(z.object({ id: z.string(), quote: QuoteSchema }), revoked.body)).toEqual({
      id: bobNoteId,
      quote: { state: "revoked", quoted_status: null },
    });

    const [deletion] = await queued(quote.alice.id, "Delete");
    if (!deletion) {
      throw new Error("no Delete was queued");
    }
    expect(deletion.payload).toEqual(
      expect.objectContaining({
        type: "Delete",
        object: expect.objectContaining({
          type: "QuoteAuthorization",
          interactingObject: quote.noteUri,
          interactionTarget: quote.statusUri,
        }),
      }),
    );
    expect(await deliveryInboxes(deletion.id)).toContain(`${quote.bob.actorUri}/inbox`);
    expect((await quoteOf(quote.email, bobNoteId))?.state).toBe("revoked");
  });
});
