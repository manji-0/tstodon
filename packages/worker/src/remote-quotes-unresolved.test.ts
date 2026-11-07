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

const remoteContent = async (objectUri: string): Promise<string | undefined> => {
  const row = await env.DB.prepare("SELECT content_html FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .first();
  return row === null ? undefined : read(z.object({ content_html: z.string() }), row).content_html;
};

const QuoteRowSchema = z.object({
  id: z.string(),
  quoted_remote_status_id: z.string().nullable(),
  quoted_uri: z.string().nullable(),
  state: z.string(),
  legacy: z.number(),
});

/** The stored quote the remote note at `objectUri` makes, if any. */
const quoteRow = async (objectUri: string) => {
  const row = await env.DB.prepare(
    `SELECT q.id, q.quoted_remote_status_id, q.quoted_uri, q.state, q.legacy
     FROM status_quotes q JOIN remote_statuses r ON r.id = q.remote_status_id
     WHERE r.object_uri = ?`,
  )
    .bind(objectUri)
    .first();
  return row === null ? undefined : read(QuoteRowSchema, row);
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
 * Bob (remote.example) quotes a note by Carol (other.example), which is not
 * cached; her stamp is `stampUri`.
 */
const setup = async (slug: string) => {
  const email = `${slug}-viewer@example.com`;
  await signedInAccount(email);
  const bob = await remoteActor(`${slug}-bob`);
  const carol = await remoteActor(`${slug}-carol`, "other.example");
  const carolNote = note(carol, `https://other.example/notes/${slug}`, {
    content: "<p>carol wrote this</p>",
  });
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
  const update = (n: number, extra: Record<string, unknown> = {}) =>
    bob.send({
      id: `${bobNoteUri}#updates/${n}`,
      type: "Update",
      object: bobNote({
        content: `<p>edit ${n}</p>`,
        updated: `2026-11-0${n + 1}T00:00:00.000Z`,
        ...extra,
      }),
    });
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
  return { bob, carol, carolNote, bobNoteUri, stampUri, stamp, bobNote, update, quote };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a legacy quote of a remote note (Q-12)", () => {
  it.each(["_misskey_quote", "quoteUrl", "quoteUri"])(
    "stores a quote named by %s as legacy, hidden while pending",
    async (key) => {
      const q = await setup(`rqu-legacy-${key.replace(/_/g, "")}`);
      const fetched = stubFetch({ [q.carolNote.id]: q.carolNote });

      expect(
        await create(
          q.bob,
          q.bobNote({ quote: undefined, quoteAuthorization: undefined, [key]: q.carolNote.id }),
        ),
      ).toBe(202);

      expect(fetched).toEqual([q.carolNote.id]);
      expect(await quoteRow(q.bobNoteUri)).toEqual(
        expect.objectContaining({
          quoted_remote_status_id: await remoteStatusId(q.carolNote.id),
          state: "pending",
          legacy: 1,
        }),
      );
      expect(await q.quote()).toBeNull();
    },
  );

  it("shows a legacy quote its stamp accepts", async () => {
    const q = await setup("rqu-legacy-stamped");
    stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: q.stamp() });

    expect(await create(q.bob, q.bobNote({ quote: undefined, quoteUri: q.carolNote.id }))).toBe(
      202,
    );

    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(q.carolNote.id) },
    });
  });

  it("reads the legacy keys in Mastodon's order", async () => {
    const q = await setup("rqu-legacy-order");
    const other = "https://other.example/notes/rqu-legacy-order-other";
    const fetched = stubFetch({ [q.carolNote.id]: q.carolNote, [other]: note(q.carol, other) });

    expect(
      await create(
        q.bob,
        q.bobNote({
          quote: undefined,
          quoteAuthorization: undefined,
          quoteUri: other,
          _misskey_quote: q.carolNote.id,
        }),
      ),
    ).toBe(202);

    expect(fetched).toEqual([q.carolNote.id]);
    expect((await quoteRow(q.bobNoteUri))?.quoted_remote_status_id).toBe(
      await remoteStatusId(q.carolNote.id),
    );
  });

  it("clears the legacy flag when an edit names the quote by quote", async () => {
    const q = await setup("rqu-legacy-upgrade");
    stubFetch({ [q.carolNote.id]: q.carolNote });
    const legacy = { quote: undefined, quoteAuthorization: undefined, quoteUrl: q.carolNote.id };
    expect(await create(q.bob, q.bobNote(legacy))).toBe(202);
    const before = await quoteRow(q.bobNoteUri);

    expect(await q.update(1, { quoteAuthorization: undefined })).toBe(202);

    expect(await quoteRow(q.bobNoteUri)).toEqual({ ...before, legacy: 0 });
    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });
});

describe("a quote of a remote note that cannot be fetched (Q-13)", () => {
  it("is kept pending with no quoted status", async () => {
    const q = await setup("rqu-unfetchable");
    stubFetch({ [q.stampUri]: q.stamp() });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await quoteRow(q.bobNoteUri)).toEqual(
      expect.objectContaining({
        quoted_remote_status_id: null,
        quoted_uri: q.carolNote.id,
        state: "pending",
        legacy: 0,
      }),
    );
    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("is rejected when its stamp does not resolve either", async () => {
    const q = await setup("rqu-unfetchable-gone");
    stubFetch({});

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await q.quote()).toEqual({ state: "rejected", quoted_status: null });
  });

  it("is resolved under the same id by a later Update, then verified", async () => {
    const q = await setup("rqu-resolve-later");
    stubFetch({ [q.carolNote.id]: SERVER_ERROR, [q.stampUri]: SERVER_ERROR });
    expect(await create(q.bob, q.bobNote())).toBe(202);
    const before = await quoteRow(q.bobNoteUri);
    expect(before?.quoted_uri).toBe(q.carolNote.id);
    vi.restoreAllMocks();
    stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: q.stamp() });

    expect(await q.update(1)).toBe(202);

    const after = await quoteRow(q.bobNoteUri);
    expect(after).toEqual({
      id: before?.id,
      quoted_remote_status_id: await remoteStatusId(q.carolNote.id),
      quoted_uri: null,
      state: "accepted",
      legacy: 0,
    });
    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(q.carolNote.id) },
    });
  });

  it("starts over when an Update names another note", async () => {
    const q = await setup("rqu-unresolved-moved");
    stubFetch({});
    expect(await create(q.bob, q.bobNote({ quoteAuthorization: undefined }))).toBe(202);
    const before = await quoteRow(q.bobNoteUri);
    const other = "https://other.example/notes/rqu-unresolved-moved-2";

    expect(await q.update(1, { quote: other, quoteAuthorization: undefined })).toBe(202);

    const after = await quoteRow(q.bobNoteUri);
    expect(after?.quoted_uri).toBe(other);
    expect(after?.id).not.toBe(before?.id);
  });

  it("takes the quoted note a verified stamp inlines when the note itself fails", async () => {
    const q = await setup("rqu-stamp-target");
    stubFetch({
      [q.carolNote.id]: SERVER_ERROR,
      [q.stampUri]: q.stamp({ interactionTarget: q.carolNote }),
    });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await remoteContent(q.carolNote.id)).toBe("<p>carol wrote this</p>");
    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(q.carolNote.id) },
    });
  });

  it("does not take a note a stamp inlines that is not the stamp author's", async () => {
    const q = await setup("rqu-stamp-forged");
    const forged = { ...q.carolNote, attributedTo: "https://other.example/users/mallory" };
    stubFetch({
      [q.carolNote.id]: SERVER_ERROR,
      [q.stampUri]: q.stamp({ interactionTarget: forged }),
    });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(await remoteStatusId(q.carolNote.id)).toBeUndefined();
    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });
});

describe("an inlined quote object (Q-13)", () => {
  it("stores the quoting author's own inlined note without fetching it", async () => {
    const q = await setup("rqu-inline-own");
    const own = note(q.bob, "https://remote.example/notes/rqu-inline-own-quoted", {
      content: "<p>my earlier note</p>",
    });
    const fetched = stubFetch({});

    expect(await create(q.bob, q.bobNote({ quote: own, quoteAuthorization: undefined }))).toBe(202);

    expect(fetched).toEqual([]);
    expect(await remoteContent(own.id)).toBe("<p>my earlier note</p>");
    expect(await q.quote()).toEqual({
      state: "accepted",
      quoted_status: { id: await remoteStatusId(own.id) },
    });
  });

  it("fetches another author's inlined note by its id instead of trusting it", async () => {
    const q = await setup("rqu-inline-forged");
    const forged = { ...q.carolNote, content: "<p>words carol never wrote</p>" };
    const fetched = stubFetch({ [q.carolNote.id]: q.carolNote, [q.stampUri]: q.stamp() });

    expect(await create(q.bob, q.bobNote({ quote: forged }))).toBe(202);

    expect(fetched).toContain(q.carolNote.id);
    expect(await remoteContent(q.carolNote.id)).toBe("<p>carol wrote this</p>");
    expect((await q.quote())?.state).toBe("accepted");
  });

  it("does not store a forged inlined note that cannot be fetched", async () => {
    const q = await setup("rqu-inline-forged-gone");
    const forged = { ...q.carolNote, content: "<p>words carol never wrote</p>" };
    stubFetch({});

    expect(await create(q.bob, q.bobNote({ quote: forged, quoteAuthorization: undefined }))).toBe(
      202,
    );

    expect(await remoteStatusId(q.carolNote.id)).toBeUndefined();
    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });

  it("does not store an inlined note claiming another host's id", async () => {
    const q = await setup("rqu-inline-other-host");
    const claimed = note(q.bob, q.carolNote.id, { content: "<p>not on bob's host</p>" });
    stubFetch({});

    expect(await create(q.bob, q.bobNote({ quote: claimed, quoteAuthorization: undefined }))).toBe(
      202,
    );

    expect(await remoteStatusId(q.carolNote.id)).toBeUndefined();
    expect((await quoteRow(q.bobNoteUri))?.quoted_uri).toBe(q.carolNote.id);
  });

  it("keeps a quote of a Tombstone pending with no quoted status", async () => {
    const q = await setup("rqu-tombstone");
    const fetched = stubFetch({});
    const tombstone = { id: q.carolNote.id, type: "Tombstone" };

    expect(
      await create(q.bob, q.bobNote({ quote: tombstone, quoteAuthorization: undefined })),
    ).toBe(202);

    expect(fetched).toEqual([q.carolNote.id]);
    expect(await remoteStatusId(q.carolNote.id)).toBeUndefined();
    expect(await quoteRow(q.bobNoteUri)).toEqual(
      expect.objectContaining({ quoted_uri: q.carolNote.id, state: "pending" }),
    );
    expect(await q.quote()).toEqual({ state: "pending", quoted_status: null });
  });
});

describe("nested quoted notes (Q-13)", () => {
  it("fetches quoted notes three levels deep and leaves the next one unresolved", async () => {
    const q = await setup("rqu-depth");
    const level = (n: number) => `https://other.example/notes/rqu-depth-${n}`;
    const fetched = stubFetch({
      [q.carolNote.id]: { ...q.carolNote, quote: level(2) },
      [level(2)]: note(q.carol, level(2), { quote: level(3) }),
      [level(3)]: note(q.carol, level(3), { quote: level(4) }),
      [level(4)]: note(q.carol, level(4)),
      [q.stampUri]: q.stamp(),
    });

    expect(await create(q.bob, q.bobNote())).toBe(202);

    expect(fetched).not.toContain(level(4));
    expect(await remoteStatusId(level(4))).toBeUndefined();
    expect((await quoteRow(q.carolNote.id))?.quoted_remote_status_id).toBe(
      await remoteStatusId(level(2)),
    );
    expect((await quoteRow(level(2)))?.state).toBe("accepted");
    expect(await quoteRow(level(3))).toEqual(
      expect.objectContaining({ quoted_uri: level(4), state: "pending" }),
    );
    expect((await q.quote())?.state).toBe("accepted");
  });

  it("stores nested inlined notes of the quoting author", async () => {
    const q = await setup("rqu-inline-nested");
    const inner = note(q.bob, "https://remote.example/notes/rqu-inline-nested-inner");
    const outer = note(q.bob, "https://remote.example/notes/rqu-inline-nested-outer", {
      quote: inner,
    });
    const fetched = stubFetch({});

    expect(await create(q.bob, q.bobNote({ quote: outer, quoteAuthorization: undefined }))).toBe(
      202,
    );

    expect(fetched).toEqual([]);
    expect((await quoteRow(outer.id))?.quoted_remote_status_id).toBe(
      await remoteStatusId(inner.id),
    );
    expect((await quoteRow(q.bobNoteUri))?.state).toBe("accepted");
  });
});
