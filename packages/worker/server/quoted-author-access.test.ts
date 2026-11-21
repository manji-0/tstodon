import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import migration from "../app/db/migrations/0165_quoted_author_mentions.sql?raw";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { deliveredCreate } from "../test/delivery-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

// Mastodon v4.7.5's `Quote#ensure_quoted_access`: a quote silently mentions
// the quoted author, who then passes `StatusPolicy#show?` on a followers-only
// quote, with no mention notification and nothing in the note's audience.

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const call = (email: string, path: string, method = "GET", body?: unknown) =>
  authHeaders(email).then((headers) =>
    SELF.fetch(`https://example.com${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const post = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await call(email, "/api/v1/statuses", "POST", body);
  expect(response.status).toBe(200);
  return read(ApiStatus, await response.json()).id;
};

/** The status as `email` opens it, or the HTTP status when it does not open. */
const open = async (email: string, id: string) => {
  const response = await call(email, `/api/v1/statuses/${id}`);
  return response.status === 200 ? read(ApiStatus, await response.json()) : response.status;
};

const notificationTypes = async (email: string, statusId: string) =>
  read(
    z.array(z.object({ type: z.string(), status: z.object({ id: z.string() }).nullish() })),
    await (await call(email, "/api/v1/notifications")).json(),
  )
    .filter((notification) => notification.status?.id === statusId)
    .map((notification) => notification.type);

const quotesOf = async (email: string, statusId: string) => {
  const response = await call(email, `/api/v1/statuses/${statusId}/quotes`);
  expect(response.status).toBe(200);
  return read(z.array(ApiStatus), await response.json());
};

const remoteNote = async (author: Remote, slug: string) => {
  const uri = `https://remote.example/notes/${slug}`;
  const object = {
    id: uri,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-11-01T00:00:00.000Z",
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
    interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
  };
  expect(await author.send({ id: `${uri}/activity`, type: "Create", object })).toBe(202);
  return read(
    z.object({ id: z.string() }),
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?").bind(uri).first(),
  ).id;
};

describe("the quoted author's silent mention", () => {
  it("lets a local quoted author open a followers-only quote, without a mention", async () => {
    const alice = "qaa-local-alice@example.com";
    const carol = "qaa-local-carol@example.com";
    const stranger = "qaa-local-stranger@example.com";
    await signedInAccount(stranger);
    const carolAccount = await signedInAccount(carol);
    const original = await post(alice, { status: "quote me" });
    const quoting = await post(carol, {
      status: "only my followers",
      quoted_status_id: original,
      visibility: "private",
    });

    const seen = await open(alice, quoting);
    expect(seen).toMatchObject({ id: quoting, mentions: [] });
    expect(await open(stranger, quoting)).toBe(404);
    expect(await notificationTypes(alice, quoting)).toEqual(["quote"]);
    expect((await quotesOf(alice, original)).map((status) => status.id)).toEqual([quoting]);
    expect(await quotesOf(stranger, original)).toEqual([]);
    const create = await deliveredCreate(
      carolAccount.id,
      `https://example.com/users/${carolAccount.username}/statuses/${quoting}`,
    );
    expect(create?.activity.object.tag).toEqual([]);
  });

  it("keeps a mention an edit drops as a silent one, as Mastodon does", async () => {
    const alice = "qaa-edit-alice@example.com";
    const carol = "qaa-edit-carol@example.com";
    const dave = "qaa-edit-dave@example.com";
    const aliceAccount = await signedInAccount(alice);
    const daveAccount = await signedInAccount(dave);
    const original = await post(alice, { status: "quote me" });
    const quoting = await post(carol, {
      status: `hey @${aliceAccount.username} @${daveAccount.username}`,
      quoted_status_id: original,
      visibility: "private",
    });
    expect(await open(alice, quoting)).toMatchObject({
      mentions: [expect.anything(), expect.anything()],
    });

    const edited = await call(carol, `/api/v1/statuses/${quoting}`, "PUT", { status: "nobody" });
    expect(edited.status).toBe(200);
    expect(read(ApiStatus, await edited.json()).mentions).toEqual([]);

    expect(await open(alice, quoting)).toMatchObject({ mentions: [] });
    expect(await open(dave, quoting)).toMatchObject({ mentions: [] });

    const again = await call(carol, `/api/v1/statuses/${quoting}`, "PUT", {
      status: `back @${daveAccount.username}`,
    });
    expect(read(ApiStatus, await again.json()).mentions.map((m) => m.id)).toEqual([daveAccount.id]);
  });

  it("lets a remote quoted author fetch a followers-only quote, without a mention", async () => {
    const alice = "qaa-remote-alice@example.com";
    const aliceAccount = await signedInAccount(alice);
    const bob = await remoteActor("qaa-remote-bob");
    const other = await remoteActor("qaa-remote-other");
    const bobNote = await remoteNote(bob, "qaa-remote");
    const quoting = await post(alice, {
      status: "only my followers",
      quoted_status_id: bobNote,
      visibility: "private",
    });
    const path = `/users/${aliceAccount.username}/statuses/${quoting}`;

    expect((await bob.fetch(path)).status).toBe(200);
    expect((await other.fetch(path)).status).toBe(404);
    expect(await open(alice, quoting)).toMatchObject({ mentions: [] });
    const create = await deliveredCreate(aliceAccount.id, `https://example.com${path}`);
    expect(create?.activity.object.tag).toEqual([]);
  });

  it("lets a remote actor an edit stopped mentioning still fetch the note", async () => {
    const alice = "qaa-remote-edit-alice@example.com";
    const aliceAccount = await signedInAccount(alice);
    const bob = await remoteActor("qaa-remote-edit-bob");
    const other = await remoteActor("qaa-remote-edit-other");
    const id = await post(alice, {
      status: "@qaa-remote-edit-bob@remote.example hi",
      visibility: "private",
    });
    const path = `/users/${aliceAccount.username}/statuses/${id}`;
    expect((await bob.fetch(path)).status).toBe(200);

    const edited = await call(alice, `/api/v1/statuses/${id}`, "PUT", { status: "hi" });
    expect(read(ApiStatus, await edited.json()).mentions).toEqual([]);

    expect((await bob.fetch(path)).status).toBe(200);
    expect((await other.fetch(path)).status).toBe(404);
    const note = read(
      z.object({ cc: z.array(z.string()), tag: z.array(z.unknown()) }),
      await (await bob.fetch(path)).json(),
    );
    expect(note.cc).not.toContain(bob.actorUri);
    expect(note.tag).toEqual([]);
  });

  it("lists a suspended author's quote for the quoted author", async () => {
    const alice = "qaa-suspended-alice@example.com";
    const carol = "qaa-suspended-carol@example.com";
    const fan = "qaa-suspended-fan@example.com";
    await signedInAccount(fan);
    const carolAccount = await signedInAccount(carol);
    const original = await post(alice, { status: "quote me" });
    const quoting = await post(carol, { status: "quoting", quoted_status_id: original });
    await env.DB.prepare(
      "INSERT INTO account_moderation (account_id, moderation) VALUES (?, 'Suspended')",
    )
      .bind(carolAccount.id)
      .run();

    const listed = await quotesOf(alice, original);
    expect(listed.map((status) => status.id)).toEqual([quoting]);
    expect(listed[0]?.account.suspended).toBe(true);
    expect(await quotesOf(fan, original)).toEqual([]);
  });
});

/** The migration's backfill statements. */
const backfillStatements = (): string[] =>
  migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*\n(?=\S|$)/)
    .map((statement) => statement.trim().replace(/;$/, ""))
    .filter((statement) => statement.startsWith("INSERT"));

const mentionRows = async (table: string, column: string, statusId: string) =>
  read(
    z.array(z.object({ who: z.string(), silent: z.number() })),
    (
      await env.DB.prepare(`SELECT ${column} AS who, silent FROM ${table} WHERE status_id = ?`)
        .bind(statusId)
        .all()
    ).results,
  );

describe("migration 0165", () => {
  it("reads each quote once by an index and seeks the rest by key", async () => {
    for (const statement of backfillStatements()) {
      const { results } = await env.DB.prepare(
        `EXPLAIN QUERY PLAN ${statement.slice(statement.indexOf("SELECT"))}`,
      ).all();
      const plan = z
        .array(z.object({ detail: z.string() }))
        .parse(results)
        .map((row) => row.detail);
      expect(plan[0], statement).toMatch(/^SEARCH q USING INDEX sqlite_autoindex_status_quotes/);
      for (const step of plan.slice(1)) {
        expect(step, statement).toMatch(/^SEARCH \w+ USING (COVERING )?INDEX \S+ \(\w+=\?\)$/);
      }
    }
  });

  it("gives the quotes stored before it their silent mention", async () => {
    const alice = "qaa-backfill-alice@example.com";
    const carol = "qaa-backfill-carol@example.com";
    const aliceAccount = await signedInAccount(alice);
    const bob = await remoteActor("qaa-backfill-bob");
    const original = await post(alice, { status: "quote me" });
    const ofLocal = await post(carol, {
      status: "hi",
      quoted_status_id: original,
      visibility: "private",
    });
    const ofLocalMentioning = await post(carol, {
      status: `@${aliceAccount.username} hi`,
      quoted_status_id: original,
      visibility: "private",
    });
    const ofRemote = await post(carol, {
      status: "hi",
      quoted_status_id: await remoteNote(bob, "qaa-backfill"),
      visibility: "private",
    });
    const unrelated = await post(carol, { status: `@${aliceAccount.username} plain` });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM status_mentions WHERE status_id = ?").bind(ofLocal),
      env.DB.prepare("DELETE FROM status_remote_mentions WHERE status_id = ?").bind(ofRemote),
    ]);

    const statements = backfillStatements();
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }

    expect(await mentionRows("status_mentions", "account_id", ofLocal)).toEqual([
      { who: aliceAccount.id, silent: 1 },
    ]);
    expect(await mentionRows("status_mentions", "account_id", ofLocalMentioning)).toEqual([
      { who: aliceAccount.id, silent: 0 },
    ]);
    expect(await mentionRows("status_remote_mentions", "actor_uri", ofRemote)).toEqual([
      { who: bob.actorUri, silent: 1 },
    ]);
    expect(await mentionRows("status_mentions", "account_id", unrelated)).toEqual([
      { who: aliceAccount.id, silent: 0 },
    ]);
  });

  it("silently mentions the quoted author of a remote quote a QuoteRequest accepted", async () => {
    const alice = "qaa-backfill-qr-alice@example.com";
    const aliceAccount = await signedInAccount(alice);
    const bob = await remoteActor("qaa-backfill-qr-bob");
    const original = await post(alice, { status: "quote me" });
    const statusUri = `https://example.com/users/${aliceAccount.username}/statuses/${original}`;
    const noteUri = "https://remote.example/notes/qaa-backfill-qr";
    expect(
      await bob.send({
        id: `${bob.actorUri}/quote_requests/qaa-backfill-qr`,
        type: "QuoteRequest",
        object: statusUri,
        instrument: {
          id: noteUri,
          type: "Note",
          attributedTo: bob.actorUri,
          content: "<p>quoting</p>",
          published: "2026-11-01T00:00:00.000Z",
          to: [`${bob.actorUri}/followers`],
          quote: statusUri,
        },
      }),
    ).toBe(202);
    const remoteId = read(
      z.object({ id: z.string() }),
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(noteUri)
        .first(),
    ).id;
    expect(await mentionRows("remote_status_mentions", "account_id", remoteId)).toEqual([
      { who: aliceAccount.id, silent: 1 },
    ]);
    await env.DB.prepare("DELETE FROM remote_status_mentions WHERE status_id = ?")
      .bind(remoteId)
      .run();

    for (const statement of backfillStatements()) {
      await env.DB.prepare(statement).run();
    }

    expect(await mentionRows("remote_status_mentions", "account_id", remoteId)).toEqual([
      { who: aliceAccount.id, silent: 1 },
    ]);
  });
});
