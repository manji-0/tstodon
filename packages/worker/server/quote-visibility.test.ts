import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
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

const remoteStatusId = async (objectUri: string): Promise<string> =>
  read(
    IdSchema,
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(objectUri)
      .first(),
  ).id;

const ShallowQuoteSchema = z.object({
  state: z.string(),
  quoted_status_id: z.string().nullable(),
});

const QuoteSchema = z.object({
  state: z.string(),
  quoted_status: z
    .object({ id: z.string(), content: z.string(), quote: ShallowQuoteSchema.nullable() })
    .nullable(),
});

/** The status's `quote` as `email` sees it, or as an anonymous viewer without one. */
const quoteAs = async (email: string | undefined, statusId: string) => {
  const response = await SELF.fetch(`https://example.com/api/v1/statuses/${statusId}`, {
    headers: email === undefined ? {} : await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(z.object({ quote: QuoteSchema }), await response.json()).quote;
};

const followRemote = async (accountId: string, actorUri: string, slug: string) => {
  await env.DB.prepare(
    `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
     VALUES (?, ?, ?, ?, 'Accepted')`,
  )
    .bind(slug, accountId, actorUri, `https://example.com/follows/${slug}`)
    .run();
};

const note = (author: Remote, slug: string, extra: Record<string, unknown>) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: "2026-11-01T00:00:00.000Z",
  ...extra,
});

const create = async (author: Remote, object: Record<string, unknown>): Promise<string> => {
  expect(await author.send({ id: `${String(object["id"])}#create`, type: "Create", object })).toBe(
    202,
  );
  return remoteStatusId(String(object["id"]));
};

/**
 * Xavier (remote) posts a followers-only note a local follower received, then
 * a public note quoting it (a self-quote, so accepted), then a public note
 * quoting that one.
 */
const remoteSelfQuotes = async (slug: string) => {
  const followerEmail = `${slug}-follower@example.com`;
  const strangerEmail = `${slug}-stranger@example.com`;
  const follower = await signedInAccount(followerEmail);
  await signedInAccount(strangerEmail);
  const xavier = await remoteActor(`${slug}-xavier`);
  await followRemote(follower.id, xavier.actorUri, slug);
  const privateNote = note(xavier, `${slug}-private`, {
    content: "<p>followers only secret</p>",
    to: [`${xavier.actorUri}/followers`],
  });
  const privateId = await create(xavier, privateNote);
  const quotingNote = note(xavier, `${slug}-quoting`, {
    to: [PUBLIC],
    cc: [`${xavier.actorUri}/followers`],
    quote: privateNote.id,
  });
  const quotingId = await create(xavier, quotingNote);
  const outerId = await create(
    xavier,
    note(xavier, `${slug}-outer`, {
      to: [PUBLIC],
      cc: [`${xavier.actorUri}/followers`],
      quote: quotingNote.id,
    }),
  );
  return { followerEmail, strangerEmail, privateId, quotingId, outerId };
};

describe("a quoted status the viewer may not see", () => {
  it("renders a remote one as unauthorized to anonymous and non-following viewers", async () => {
    const q = await remoteSelfQuotes("qv-remote");

    expect(await quoteAs(q.followerEmail, q.quotingId)).toEqual({
      state: "accepted",
      quoted_status: expect.objectContaining({
        id: q.privateId,
        content: "<p>followers only secret</p>",
      }),
    });
    expect(await quoteAs(undefined, q.quotingId)).toEqual({
      state: "unauthorized",
      quoted_status: null,
    });
    expect(await quoteAs(q.strangerEmail, q.quotingId)).toEqual({
      state: "unauthorized",
      quoted_status: null,
    });
  });

  it("renders a nested quote by id only to viewers who may see its status", async () => {
    const q = await remoteSelfQuotes("qv-shallow");

    expect((await quoteAs(q.followerEmail, q.outerId)).quoted_status?.quote).toEqual({
      state: "accepted",
      quoted_status_id: q.privateId,
    });
    for (const viewer of [undefined, q.strangerEmail]) {
      expect((await quoteAs(viewer, q.outerId)).quoted_status?.quote).toEqual({
        state: "unauthorized",
        quoted_status_id: null,
      });
    }
  });

  it("renders one quoted by a local status as unauthorized to viewers who may not see it", async () => {
    // The API never lets a local status quote one with a narrower audience,
    // so the quotes are stored as a stale or imported row would be.
    const q = await remoteSelfQuotes("qv-local");
    const aliceEmail = "qv-local-alice@example.com";
    const bobEmail = "qv-local-bob@example.com";
    const post = async (email: string, body: Record<string, unknown>) => {
      const response = await SELF.fetch("https://example.com/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return read(IdSchema, await response.json()).id;
    };
    await signedInAccount(aliceEmail);
    await signedInAccount(bobEmail);
    const bobPrivateId = await post(bobEmail, { status: "secret", visibility: "private" });
    const quotingLocal = await post(aliceEmail, { status: "quoting a local status" });
    const quotingRemote = await post(aliceEmail, { status: "quoting a remote status" });
    const insertQuote = (id: string, statusId: string, column: string, quotedId: string) =>
      env.DB.prepare(
        `INSERT INTO status_quotes (id, status_id, ${column}, state, created_at, updated_at)
         VALUES (?, ?, ?, 'accepted', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
      )
        .bind(id, statusId, quotedId)
        .run();
    await insertQuote(`${quotingLocal}0`, quotingLocal, "quoted_status_id", bobPrivateId);
    await insertQuote(`${quotingRemote}0`, quotingRemote, "quoted_remote_status_id", q.privateId);

    expect(await quoteAs(bobEmail, quotingLocal)).toEqual({
      state: "accepted",
      quoted_status: expect.objectContaining({ id: bobPrivateId }),
    });
    expect(await quoteAs(q.followerEmail, quotingRemote)).toEqual({
      state: "accepted",
      quoted_status: expect.objectContaining({ id: q.privateId }),
    });
    for (const viewer of [undefined, q.strangerEmail]) {
      for (const statusId of [quotingLocal, quotingRemote]) {
        expect(await quoteAs(viewer, statusId)).toEqual({
          state: "unauthorized",
          quoted_status: null,
        });
      }
    }
  });
});
