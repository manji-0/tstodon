import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const StoredSchema = z.object({ actor_uri: z.string(), content_html: z.string() }).nullable();

const stored = async (objectUri: string) =>
  read(
    StoredSchema,
    await env.DB.prepare("SELECT actor_uri, content_html FROM remote_statuses WHERE object_uri = ?")
      .bind(objectUri)
      .first(),
  );

const note = (author: Remote, uri: string, extra: Record<string, unknown> = {}) => ({
  id: uri,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>written by ${author.actorUri}</p>`,
  published: "2026-11-01T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...extra,
});

/** Serve each body as JSON at its URL; anything else is a 404. */
const stubFetch = (served: Record<string, unknown>): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = served[new Request(input, init).url];
    return body === undefined ? new Response(null, { status: 404 }) : Response.json(body);
  });
};

/** Bob and Carol share remote.example; Carol's note is cached. */
const neighbours = async (slug: string) => {
  const bob = await remoteActor(`${slug}-bob`);
  const carol = await remoteActor(`${slug}-carol`);
  const carolNote = note(carol, `https://remote.example/notes/${slug}-carol`);
  expect(
    await carol.send({ id: `${carolNote.id}#create`, type: "Create", object: carolNote }),
  ).toBe(202);
  expect(await stored(carolNote.id)).toEqual({
    actor_uri: carol.actorUri,
    content_html: carolNote.content,
  });
  return { bob, carol, carolNote };
};

afterEach(() => {
  vi.restoreAllMocks();
});

const quoteRequest = async (slug: string) => {
  const email = `${slug}-alice@example.com`;
  const alice = await signedInAccount(email);
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: "quote me" }),
  });
  expect(response.status).toBe(200);
  const statusId = read(z.object({ id: z.string() }), await response.json()).id;
  const statusUri = `https://example.com/users/${alice.username}/statuses/${statusId}`;
  const { bob, carol, carolNote } = await neighbours(slug);
  const instrument = `https://remote.example/notes/${slug}-instrument`;
  return { alice, bob, carol, carolNote, instrument, statusUri };
};

const accepts = async (accountId: string) =>
  read(
    z.object({ n: z.number() }),
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbound_activities WHERE account_id = ? AND kind = 'Accept'",
    )
      .bind(accountId)
      .first(),
  );

describe("a QuoteRequest instrument fetched under another URI", () => {
  it.each([
    ["names another actor's cached note", "cached", (carolUri: string) => carolUri],
    ["names an id on another host", "cross-host", () => "https://other.example/notes/forged"],
    ["names another id on its host", "same-host", () => "https://remote.example/notes/forged"],
  ])("is dropped when the fetched document %s", async (_label, slug, idOf) => {
    const q = await quoteRequest(`own-qr-${slug}`);
    const forgedId = idOf(q.carolNote.id);
    stubFetch({
      [q.instrument]: note(q.bob, forgedId, {
        content: "<p>overwritten</p>",
        quote: q.statusUri,
      }),
    });

    expect(
      await q.bob.send({
        id: `${q.bob.actorUri}/quote_requests/${slug}`,
        type: "QuoteRequest",
        object: q.statusUri,
        instrument: q.instrument,
      }),
    ).toBe(202);

    expect((await accepts(q.alice.id)).n).toBe(0);
    const carols = { actor_uri: q.carol.actorUri, content_html: q.carolNote.content };
    expect(await stored(q.carolNote.id)).toEqual(carols);
    expect(await stored(forgedId)).toEqual(forgedId === q.carolNote.id ? carols : null);
  });
});
