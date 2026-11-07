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

const IdSchema = z.object({ id: z.string() });

const remoteStatusId = async (objectUri: string): Promise<string | undefined> => {
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .first();
  return row === null ? undefined : read(IdSchema, row).id;
};

const QuoteSchema = z
  .object({ state: z.string(), quoted_status: z.object({ id: z.string() }).nullable() })
  .nullable();

const SERVER_ERROR = Symbol("500");

/**
 * The URLs the worker fetched, while the stub serves each `served` body as
 * JSON (a 500 for {@link SERVER_ERROR}) and anything else as a 404.
 */
const stubFetch = (served: Record<string, unknown>): string[] => {
  const fetched: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    fetched.push(url);
    const body = served[url];
    if (body === undefined || body === SERVER_ERROR) {
      return new Response(null, { status: body === undefined ? 404 : 500 });
    }
    return Response.json(body);
  });
  return fetched;
};

const note = (author: Remote, uri: string, extra: Record<string, unknown> = {}) => ({
  id: uri,
  type: "Note",
  attributedTo: author.actorUri,
  content: "<p>hello</p>",
  published: "2026-11-01T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...extra,
});

const create = (author: Remote, object: Record<string, unknown>) =>
  author.send({ id: `${String(object["id"])}#create`, type: "Create", object });

/**
 * Bob (remote.example) quotes a note by Carol (other.example). Carol's note
 * is cached unless `cacheQuoted` is false; her stamp is `stampUri`.
 */
const setup = async (slug: string, options: Readonly<{ cacheQuoted?: false }> = {}) => {
  const email = `${slug}-viewer@example.com`;
  await signedInAccount(email);
  const bob = await remoteActor(`${slug}-bob`);
  const carol = await remoteActor(`${slug}-carol`, "other.example");
  const carolNote = note(carol, `https://other.example/notes/${slug}`);
  if (options.cacheQuoted !== false) {
    expect(await create(carol, carolNote)).toBe(202);
  }
  const bobNoteUri = `https://remote.example/notes/${slug}`;
  const stampUri = `${carol.actorUri}/stamps/${slug}`;
  const stamp = (extra: Record<string, unknown> = {}) => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: stampUri,
    type: "QuoteAuthorization",
    attributedTo: carol.actorUri,
    interactingObject: bobNoteUri,
    interactionTarget: carolNote.id,
    ...extra,
  });
  const bobNote = (extra: Record<string, unknown> = {}) =>
    note(bob, bobNoteUri, { quote: carolNote.id, quoteAuthorization: stampUri, ...extra });
  const quote = async () => {
    const id = await remoteStatusId(bobNoteUri);
    if (id === undefined) {
      throw new Error("Bob's note was not stored");
    }
    const response = await SELF.fetch(new URL(`/api/v1/statuses/${id}`, "https://example.com"), {
      headers: await authHeaders(email),
    });
    expect(response.status).toBe(200);
    return read(z.object({ quote: QuoteSchema }), await response.json()).quote;
  };
  return { bob, carol, carolNote, bobNoteUri, stampUri, stamp, bobNote, quote };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a remote note quoting another remote note", () => {
  it("is accepted on a stamp that verifies", async () => {
    const q = await setup("rqq-accept");
    const fetched = stubFetch({ [q.stampUri]: q.stamp() });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(fetched).toEqual([q.stampUri]);
    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(q.carolNote.id) },
    });
  });

  it.each([
    ["names another quoting note", "quoting", { interactingObject: "https://remote.example/x" }],
    ["is attributed to someone else", "author", { attributedTo: "https://other.example/users/d" }],
    ["names another quoted note", "quoted", { interactionTarget: "https://other.example/x" }],
    ["is not a QuoteAuthorization", "type", { type: "Note" }],
  ])("stays pending on a stamp that %s", async (_label, slug, extra) => {
    const q = await setup(`rqq-mismatch-${slug}`);
    stubFetch({ [q.stampUri]: q.stamp(extra) });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("stays pending on a stamp served from a host other than its author's", async () => {
    const q = await setup("rqq-cross-host");
    const crossHost = "https://elsewhere.example/stamps/rqq-cross-host";
    stubFetch({ [crossHost]: q.stamp({ id: crossHost }) });

    expect(await create(q.bob, q.bobNote({ quoteAuthorization: crossHost }))).toBe(202);

    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("stays pending with no stamp", async () => {
    const q = await setup("rqq-no-stamp");
    const fetched = stubFetch({});
    expect(await create(q.bob, q.bobNote({ quoteAuthorization: undefined }))).toBe(202);

    expect(fetched).toEqual([]);
    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("stays pending when the stamp fetch fails", async () => {
    const q = await setup("rqq-stamp-500");
    stubFetch({ [q.stampUri]: SERVER_ERROR });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("is rejected when the stamp does not resolve", async () => {
    const q = await setup("rqq-stamp-404");
    stubFetch({});

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await q.quote()).toEqual({ state: "rejected", quoted_status: null });
  });

  it("fetches an inline stamp by its id instead of trusting it", async () => {
    const q = await setup("rqq-inline");
    const fetched = stubFetch({
      [q.stampUri]: q.stamp({ interactingObject: "https://remote.example/x" }),
    });

    expect(await create(q.bob, q.bobNote({ quoteAuthorization: q.stamp() }))).toBe(202);

    expect(fetched).toEqual([q.stampUri]);
    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("fetches an uncached quoted note once, then verifies its stamp", async () => {
    const q = await setup("rqq-uncached", { cacheQuoted: false });
    const fetched = stubFetch({
      [q.carolNote.id]: q.carolNote,
      [q.stampUri]: q.stamp(),
    });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(fetched.filter((url) => url === q.carolNote.id)).toHaveLength(1);
    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(q.carolNote.id) },
    });
  });

  it("fetches the quoted note's own quoted note", async () => {
    const q = await setup("rqq-depth", { cacheQuoted: false });
    const deeper = "https://other.example/notes/rqq-depth-deeper";
    const fetched = stubFetch({
      [q.carolNote.id]: { ...q.carolNote, quote: deeper },
      [deeper]: note(q.carol, deeper),
      [q.stampUri]: q.stamp(),
    });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(fetched).toContain(deeper);
    expect(await remoteStatusId(deeper)).toBeDefined();
    expect((await q.quote())?.state).toBe("accepted");
  });

  it("keeps a pending quote with no status when the quoted note cannot be fetched", async () => {
    const q = await setup("rqq-unfetchable", { cacheQuoted: false });
    stubFetch({ [q.stampUri]: q.stamp() });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("accepts a self-quote without fetching anything", async () => {
    const q = await setup("rqq-self");
    const own = note(q.bob, "https://remote.example/notes/rqq-self-own");
    expect(await create(q.bob, own)).toBe(202);
    const fetched = stubFetch({});

    expect(await create(q.bob, q.bobNote({ quote: own.id, quoteAuthorization: undefined }))).toBe(
      202,
    );

    expect(fetched).toEqual([]);
    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(own.id) },
    });
  });

  it("is revoked when the quoted author deletes the stamp", async () => {
    const q = await setup("rqq-revoke");
    stubFetch({ [q.stampUri]: q.stamp() });
    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(
      await q.carol.send({
        id: `${q.stampUri}#delete`,
        type: "Delete",
        object: { id: q.stampUri, type: "QuoteAuthorization" },
      }),
    ).toBe(202);

    expect(await q.quote()).toEqual({ state: "revoked", quoted_status: null });
    expect(await remoteStatusId(q.bobNoteUri)).toBeDefined();
  });

  it("keeps the quote when someone other than the quoted author deletes the stamp", async () => {
    const q = await setup("rqq-revoke-stranger");
    stubFetch({ [q.stampUri]: q.stamp() });
    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(
      await q.bob.send({
        id: `${q.stampUri}#delete`,
        type: "Delete",
        object: { id: q.stampUri, type: "QuoteAuthorization" },
      }),
    ).toBe(202);

    expect((await q.quote())?.state).toBe("accepted");
  });

  it("keeps a legacy-only quote, hidden until accepted", async () => {
    const q = await setup("rqq-legacy");
    const fetched = stubFetch({});
    const legacy = q.bobNote({
      quote: undefined,
      quoteAuthorization: undefined,
      _misskey_quote: q.carolNote.id,
    });

    expect(await create(q.bob, legacy)).toBe(202);

    expect(fetched).toEqual([]);
    expect(await q.quote()).toBeNull();
  });
});

describe("an Update of a remote note quoting a remote note", () => {
  const update = (q: Awaited<ReturnType<typeof setup>>, n: number, extra = {}) =>
    q.bob.send({
      id: `${q.bobNoteUri}#updates/${n}`,
      type: "Update",
      object: q.bobNote({
        content: `<p>edit ${n}</p>`,
        updated: `2026-11-0${n + 1}T00:00:00.000Z`,
        ...extra,
      }),
    });

  it("keeps an accepted quote of the same note and stamp without fetching", async () => {
    const q = await setup("rqq-update-same");
    stubFetch({ [q.stampUri]: q.stamp() });
    expect(await create(q.bob, q.bobNote())).toBe(202);
    vi.restoreAllMocks();
    const fetched = stubFetch({});

    expect(await update(q, 1)).toBe(202);

    expect(fetched).toEqual([]);
    expect((await q.quote())?.state).toBe("accepted");
  });

  it("verifies a pending quote again", async () => {
    const q = await setup("rqq-update-retry");
    stubFetch({ [q.stampUri]: SERVER_ERROR });
    expect(await create(q.bob, q.bobNote())).toBe(202);
    expect((await q.quote())?.state).toBe("pending");
    vi.restoreAllMocks();
    stubFetch({ [q.stampUri]: q.stamp() });

    expect(await update(q, 1)).toBe(202);

    expect((await q.quote())?.state).toBe("accepted");
  });

  it("verifies a changed quoted note", async () => {
    const q = await setup("rqq-update-target");
    stubFetch({ [q.stampUri]: q.stamp() });
    expect(await create(q.bob, q.bobNote())).toBe(202);
    const other = note(q.carol, "https://other.example/notes/rqq-update-target-2");
    expect(await create(q.carol, other)).toBe(202);
    vi.restoreAllMocks();
    const fetched = stubFetch({
      [q.stampUri]: q.stamp({ interactionTarget: other.id }),
    });

    expect(await update(q, 1, { quote: other.id })).toBe(202);

    expect(fetched).toEqual([q.stampUri]);
    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(other.id) },
    });
  });

  it("forgets the quote when the note drops it", async () => {
    const q = await setup("rqq-update-drop");
    stubFetch({ [q.stampUri]: q.stamp() });
    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await update(q, 1, { quote: undefined, quoteAuthorization: undefined })).toBe(202);

    expect(await q.quote()).toBeNull();
  });
});
