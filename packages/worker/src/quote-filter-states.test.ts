import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const IdSchema = z.object({ id: z.string() });

const QuoteSchema = z.object({
  state: z.string(),
  quoted_status: z
    .object({
      id: z.string(),
      quote: z.object({ state: z.string(), quoted_status_id: z.string().nullable() }).nullable(),
    })
    .nullable(),
});

const send = async (email: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(200);
  return response.json();
};

/** The status's `quote` as `email` sees it, or as an anonymous viewer without one. */
const quoteAs = async (email: string | undefined, statusId: string) => {
  const response = await SELF.fetch(`https://example.com/api/v1/statuses/${statusId}`, {
    headers: email === undefined ? {} : await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(z.object({ quote: QuoteSchema }), await response.json()).quote;
};

const remoteNote = async (
  author: Remote,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const uri = `${author.actorUri}/notes/${slug}`;
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
  expect(await author.send({ id: `${uri}#create`, type: "Create", object })).toBe(202);
  return read(
    IdSchema,
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?").bind(uri).first(),
  ).id;
};

const acceptQuote = (
  quoting: string,
  quotingColumn: string,
  quoted: string,
  quotedColumn: string,
) =>
  env.DB.prepare(
    `INSERT INTO status_quotes (id, ${quotingColumn}, ${quotedColumn}, state, created_at, updated_at)
     VALUES (?, ?, ?, 'accepted', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  )
    .bind(`${quoting}-${quoted}`, quoting, quoted)
    .run();

/**
 * A local author's public note and a public note of a remote author on
 * `quoted.example`, each quoted (accepted) by a local status and by a
 * remote one on `remote.example`, and a remote note quoting the remote
 * quote of the local note, so its quote renders shallow inside another.
 */
const quotes = async (slug: string) => {
  const viewer = `${slug}-viewer@example.com`;
  const quotedAuthor = `${slug}-quoted@example.com`;
  const quotingAuthor = `${slug}-quoting@example.com`;
  const viewerAccount = await signedInAccount(viewer);
  const local = await signedInAccount(quotedAuthor);
  await signedInAccount(quotingAuthor);
  const remote = await remoteActor(`${slug}-remote`, "quoted.example");
  const quoter = await remoteActor(`${slug}-quoter`);
  const post = async (email: string, status: string) =>
    read(IdSchema, await send(email, "/api/v1/statuses", { status })).id;

  const localQuoted = await post(quotedAuthor, "the local quoted note");
  const remoteQuoted = await remoteNote(remote, `${slug}-quoted`);
  const localOfLocal = await post(quotingAuthor, "a local quote of a local note");
  const localOfRemote = await post(quotingAuthor, "a local quote of a remote note");
  const remoteOfLocal = await remoteNote(quoter, `${slug}-of-local`);
  const remoteOfRemote = await remoteNote(quoter, `${slug}-of-remote`);
  await acceptQuote(localOfLocal, "status_id", localQuoted, "quoted_status_id");
  await acceptQuote(localOfRemote, "status_id", remoteQuoted, "quoted_remote_status_id");
  await acceptQuote(remoteOfLocal, "remote_status_id", localQuoted, "quoted_status_id");
  await acceptQuote(remoteOfRemote, "remote_status_id", remoteQuoted, "quoted_remote_status_id");
  const outer = await remoteNote(quoter, `${slug}-outer`, {
    quote: `${quoter.actorUri}/notes/${slug}-of-local`,
  });
  return {
    viewer,
    viewerId: viewerAccount.id,
    quotedAuthor,
    localAuthorId: local.id,
    remoteAuthorId: RemoteAccountId.encode(remote.actorUri),
    localQuoted,
    remoteQuoted,
    ofLocal: [localOfLocal, remoteOfLocal],
    ofRemote: [localOfRemote, remoteOfRemote],
    outer,
  };
};

type Quotes = Awaited<ReturnType<typeof quotes>>;

const expectState = async (
  viewer: string | undefined,
  statusIds: ReadonlyArray<string>,
  state: string,
  quotedId: string | null,
) => {
  for (const statusId of statusIds) {
    expect(await quoteAs(viewer, statusId)).toEqual({
      state,
      quoted_status: quotedId === null ? null : expect.objectContaining({ id: quotedId }),
    });
  }
};

const shallowAs = async (viewer: string | undefined, q: Quotes) =>
  (await quoteAs(viewer, q.outer)).quoted_status?.quote;

describe("a quoted status filtered for the viewer", () => {
  it("is labelled blocked_account, still shown, when the viewer blocks its author", async () => {
    const q = await quotes("qf-block");
    await send(q.viewer, `/api/v1/accounts/${q.localAuthorId}/block`);
    await send(q.viewer, `/api/v1/accounts/${q.remoteAuthorId}/block`);

    await expectState(q.viewer, q.ofLocal, "blocked_account", q.localQuoted);
    await expectState(q.viewer, q.ofRemote, "blocked_account", q.remoteQuoted);
    expect(await shallowAs(q.viewer, q)).toEqual({
      state: "blocked_account",
      quoted_status_id: q.localQuoted,
    });
    await expectState(undefined, q.ofLocal, "accepted", q.localQuoted);
    await expectState(undefined, q.ofRemote, "accepted", q.remoteQuoted);
  });

  it("is labelled muted_account when the viewer mutes its author, a block winning", async () => {
    const q = await quotes("qf-mute");
    await send(q.viewer, `/api/v1/accounts/${q.localAuthorId}/mute`, {});
    await send(q.viewer, `/api/v1/accounts/${q.remoteAuthorId}/mute`, {});

    await expectState(q.viewer, q.ofLocal, "muted_account", q.localQuoted);
    await expectState(q.viewer, q.ofRemote, "muted_account", q.remoteQuoted);
    expect(await shallowAs(q.viewer, q)).toEqual({
      state: "muted_account",
      quoted_status_id: q.localQuoted,
    });

    await send(q.viewer, `/api/v1/accounts/${q.localAuthorId}/block`);
    await expectState(q.viewer, q.ofLocal, "blocked_account", q.localQuoted);
  });

  it("is labelled blocked_domain when the viewer blocks its author's domain, before a block", async () => {
    const q = await quotes("qf-domain");
    await send(q.viewer, `/api/v1/accounts/${q.remoteAuthorId}/block`);
    await send(q.viewer, "/api/v1/domain_blocks", { domain: "quoted.example" });

    await expectState(q.viewer, q.ofRemote, "blocked_domain", q.remoteQuoted);
    await expectState(q.viewer, q.ofLocal, "accepted", q.localQuoted);
  });

  it("is unauthorized, without its status, when its author blocks the viewer", async () => {
    const q = await quotes("qf-blocked-by");
    await send(q.quotedAuthor, `/api/v1/accounts/${q.viewerId}/block`);

    await expectState(q.viewer, q.ofLocal, "unauthorized", null);
    expect(await shallowAs(q.viewer, q)).toEqual({
      state: "unauthorized",
      quoted_status_id: null,
    });
    await expectState(undefined, q.ofLocal, "accepted", q.localQuoted);
    await expectState(q.viewer, q.ofRemote, "accepted", q.remoteQuoted);
  });
});
