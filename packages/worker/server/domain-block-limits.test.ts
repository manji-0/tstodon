import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { withQueueDrained } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { listUnfollowedSilencedAuthorsJson } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

/**
 * Mastodon v4.7.5's `BlockDomainService` silences or suspends every account
 * at or under the blocked domain when the block is made (`silenced_at`,
 * `suspended_at` set to the block's `created_at`), a narrower rule
 * notwithstanding, so an account known then stays limited under a narrower
 * `noop`; an account first seen later follows `DomainBlock.rule_for` alone
 * (`ActivityPub::ProcessAccountService#create_account`). Changing the block's
 * severity (`process_retroactive_updates!`) or removing it
 * (`UnblockDomainService`) lifts what the block set.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

type Severity = "silence" | "suspend" | "noop";

const ADMIN = "domain-limits-admin@example.com";

const adminFetch = async (path: string, method: string, body?: unknown): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(ADMIN, { admin: true })) },
    body: body === undefined ? null : JSON.stringify(body),
  });

/** Everything a block change sets off, run as the queue would. */
const settled = <T>(work: () => Promise<T>): Promise<T> =>
  withQueueDrained(["RecordDomainBlockLimits"], work);

const block = (domain: string, severity: Severity): Promise<string> =>
  settled(async () => {
    const response = await adminFetch("/api/v1/admin/domain_blocks", "POST", { domain, severity });
    expect(response.status).toBe(200);
    return z.object({ id: z.string() }).parse(await response.json()).id;
  });

const changeBlock = (id: string, severity: Severity): Promise<void> =>
  settled(async () => {
    const response = await adminFetch(`/api/v1/admin/domain_blocks/${id}`, "PUT", { severity });
    expect(response.status).toBe(200);
  });

const unblock = (id: string): Promise<void> =>
  settled(async () => {
    const response = await adminFetch(`/api/v1/admin/domain_blocks/${id}`, "DELETE");
    expect(response.status).toBe(200);
  });

const createNote = (remote: Remote, uri: string): Promise<number> =>
  remote.send({
    id: `${uri}/activity`,
    type: "Create",
    object: {
      id: uri,
      type: "Note",
      attributedTo: remote.actorUri,
      content: "<p>remote note</p>",
      published: "2026-11-01T00:00:00.000Z",
      to: [PUBLIC],
      cc: [`${remote.actorUri}/followers`],
    },
  });

const publicRemoteUris = async (): Promise<string[]> => {
  const response = await SELF.fetch(
    "https://example.com/api/v1/timelines/public?remote=true&limit=40",
  );
  expect(response.status).toBe(200);
  return z
    .array(z.object({ uri: z.string() }))
    .parse(await response.json())
    .map((status) => status.uri);
};

/**
 * Whether the account lookup finds the actor: tstodon answers 404 for an
 * actor a domain suspension covers, as it does for one on a suspended domain.
 */
const lookedUp = async (acct: string): Promise<boolean> => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
  );
  expect([200, 404]).toContain(response.status);
  return response.status === 200;
};

const silencedAuthors = async (actorUris: ReadonlyArray<string>): Promise<string[]> => {
  const typed = listUnfollowedSilencedAuthorsJson("", "[]", JSON.stringify(actorUris));
  const { results } = await d1PrepareTyped(env.DB, typed).all();
  return z
    .array(z.object({ author: z.string() }))
    .parse(results)
    .map((row) => row.author);
};

/** An actor under `domain`'s `open.` subdomain, exempted by a `noop`, with a public note. */
const knownUnderNoop = async (
  domain: string,
): Promise<Readonly<{ known: Remote; note: string }>> => {
  await block(`open.${domain}`, "noop");
  const known = await remoteActor("known", `open.${domain}`);
  const note = `https://open.${domain}/notes/before`;
  expect(await createNote(known, note)).toBe(202);
  expect(await publicRemoteUris()).toContain(note);
  return { known, note };
};

describe("an instance suspension made over a narrower noop", () => {
  it("keeps the actors known there suspended", async () => {
    const { known, note } = await knownUnderNoop("keep-susp.example");

    await block("keep-susp.example", "suspend");

    expect(await publicRemoteUris()).not.toContain(note);
    expect(await lookedUp("known@open.keep-susp.example")).toBe(false);
    expect(await createNote(known, "https://open.keep-susp.example/notes/after")).toBe(403);
  });

  it("leaves an actor first seen after the block to the narrower rule", async () => {
    await block("open.late-susp.example", "noop");
    await block("late-susp.example", "suspend");
    const later = await remoteActor("later", "open.late-susp.example");
    const note = "https://open.late-susp.example/notes/1";

    expect(await createNote(later, note)).toBe(202);
    expect(await publicRemoteUris()).toContain(note);
    expect(await lookedUp("later@open.late-susp.example")).toBe(true);
  });

  it("lifts the suspension when the block is removed", async () => {
    const { known, note } = await knownUnderNoop("lift-susp.example");
    const id = await block("lift-susp.example", "suspend");

    await unblock(id);

    expect(await publicRemoteUris()).toContain(note);
    expect(await lookedUp("known@open.lift-susp.example")).toBe(true);
    expect(await createNote(known, "https://open.lift-susp.example/notes/after")).toBe(202);
  });

  it("lifts the suspension when the block becomes a noop", async () => {
    const { known, note } = await knownUnderNoop("noop-susp.example");
    const id = await block("noop-susp.example", "suspend");

    await changeBlock(id, "noop");

    expect(await publicRemoteUris()).toContain(note);
    expect(await createNote(known, "https://open.noop-susp.example/notes/after")).toBe(202);
  });

  it("silences the actors instead when the block becomes a silence", async () => {
    const { known, note } = await knownUnderNoop("down-susp.example");
    const id = await block("down-susp.example", "suspend");

    await changeBlock(id, "silence");

    expect(await publicRemoteUris()).not.toContain(note);
    expect(await lookedUp("known@open.down-susp.example")).toBe(true);
    expect(await silencedAuthors([known.actorUri])).toEqual([known.actorUri]);
    expect(await createNote(known, "https://open.down-susp.example/notes/after")).toBe(202);
  });
});

describe("an instance silence made over a narrower noop", () => {
  it("keeps the actors known there silenced until the block is removed", async () => {
    const { known, note } = await knownUnderNoop("keep-sil.example");
    const id = await block("keep-sil.example", "silence");

    expect(await publicRemoteUris()).not.toContain(note);
    expect(await silencedAuthors([known.actorUri])).toEqual([known.actorUri]);

    await unblock(id);

    expect(await publicRemoteUris()).toContain(note);
    expect(await silencedAuthors([known.actorUri])).toEqual([]);
  });
});

describe("a block over more actors than one page", () => {
  it("limits each of them, in queued pages, and forgets them once removed", async () => {
    const count = 1201;
    await block("open.many-susp.example", "noop");
    await env.DB.prepare(
      `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ?)
       INSERT INTO remote_actors (actor_uri, username, domain, inbox_uri, public_key_id, public_key_pem, fetched_at)
       SELECT printf('https://open.many-susp.example/users/u%04d', n), printf('u%04d', n),
              'open.many-susp.example', 'https://open.many-susp.example/inbox',
              printf('https://open.many-susp.example/users/u%04d#main-key', n), 'x',
              '2026-11-01T00:00:00.000Z'
       FROM series`,
    )
      .bind(count)
      .run();
    const suspended = async (): Promise<number> => {
      const row = await env.DB.prepare(
        `SELECT count(DISTINCT actor_uri) AS n FROM remote_actor_domain_rules
         WHERE severity = 'suspend' AND actor_uri LIKE 'https://open.many-susp.example/%'`,
      ).first();
      return z.object({ n: z.number() }).parse(row).n;
    };

    const id = await block("many-susp.example", "suspend");

    expect(await suspended()).toBe(count);

    await unblock(id);

    expect(await suspended()).toBe(0);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM remote_actor_domain_limits WHERE domain_block_id = ?",
    )
      .bind(id)
      .first();
    expect(z.object({ n: z.number() }).parse(left).n).toBe(0);
  });
});
