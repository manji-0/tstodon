import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAdminAccount, type ApiAdminAccountJSON } from "@tstodon/api";
import { authHeaders } from "../test/auth-fixture";
import { postForm, signUp } from "../test/passkey-browser";
import { withQueueDrained } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { recordPageSql } from "./domain-block-limits";
import { listUnfollowedSilencedAuthorsJson } from "./generated/prisma/sql";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
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
 * Whether the account lookup finds the actor and renders it `suspended`. It
 * answers 404 on a suspended host (`ResolveAccountService` stops at
 * `domain_not_allowed?`); an actor a suspension suspended on a host a
 * narrower `noop` exempts is found, with `suspended: true`.
 */
const lookup = async (acct: string): Promise<"NotFound" | "Suspended" | "Shown"> => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
  );
  expect([200, 404]).toContain(response.status);
  if (response.status === 404) {
    return "NotFound";
  }
  const { suspended } = z
    .object({ suspended: z.boolean().optional() })
    .parse(await response.json());
  return suspended === true ? "Suspended" : "Shown";
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
    expect(await lookup("known@open.keep-susp.example")).toBe("Suspended");
    expect(await createNote(known, "https://open.keep-susp.example/notes/after")).toBe(403);
  });

  it("leaves an actor first seen after the block to the narrower rule", async () => {
    await block("open.late-susp.example", "noop");
    await block("late-susp.example", "suspend");
    const later = await remoteActor("later", "open.late-susp.example");
    const note = "https://open.late-susp.example/notes/1";

    expect(await createNote(later, note)).toBe(202);
    expect(await publicRemoteUris()).toContain(note);
    expect(await lookup("later@open.late-susp.example")).toBe("Shown");
  });

  it("lifts the suspension when the block is removed", async () => {
    const { known, note } = await knownUnderNoop("lift-susp.example");
    const id = await block("lift-susp.example", "suspend");

    await unblock(id);

    expect(await publicRemoteUris()).toContain(note);
    expect(await lookup("known@open.lift-susp.example")).toBe("Shown");
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
    expect(await lookup("known@open.down-susp.example")).toBe("Shown");
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

const limitRows = async (where: string, bind: string): Promise<number> => {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM remote_actor_domain_limits WHERE ${where} = ?`,
  )
    .bind(bind)
    .first();
  return z.object({ n: z.number() }).parse(row).n;
};

describe("a page of a block's actors", () => {
  // Page k reads its own rows by the key's index, not the k - 1 pages before it.
  it.each(["AccountDomain", "UriHost"] as const)(
    "seeks the %s key's index in its own order",
    async (host) => {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${recordPageSql(host)}`)
        .bind("block", "com.example.", "com.example/", "com.example.a.", 7, 500)
        .all();
      const details = z
        .array(z.object({ detail: z.string() }))
        .parse(results)
        .map((row) => row.detail);
      expect(details.join("\n")).toMatch(/^SEARCH remote_actors USING (COVERING )?INDEX /);
      expect(details.filter((detail) => /^SCAN |TEMP B-TREE/.test(detail))).toEqual([]);
    },
  );
});

describe("a block removed while its rows were left", () => {
  it("has them deleted by the hourly sweep, a live block's rows kept", async () => {
    const { known } = await knownUnderNoop("orphan-susp.example");
    await remoteActor("kept", "kept-susp.example");
    const kept = await block("kept-susp.example", "suspend");
    const gone = await block("orphan-susp.example", "suspend");
    // Removed without starting its deletion, as a chain that died.
    await env.DB.prepare("DELETE FROM domain_blocks WHERE id = ?").bind(gone).run();
    expect(await limitRows("domain_block_id", gone)).toBe(1);

    await settled(async () => {
      expect(await processOutboxJob(env, { kind: "ResumeLiftedDomainBlockLimits" })).toBe("ok");
    });

    expect(await limitRows("domain_block_id", gone)).toBe(0);
    expect(await limitRows("domain_block_id", kept)).toBe(1);
    expect(await limitRows("actor_uri", known.actorUri)).toBe(0);
  });
});

describe("an actor a domain suspension suspended", () => {
  it("can still delete its own account, which forgets its limitation", async () => {
    const { known } = await knownUnderNoop("gone-susp.example");
    await block("gone-susp.example", "suspend");
    expect(await limitRows("actor_uri", known.actorUri)).toBe(1);

    expect(
      await known.send({
        id: `${known.actorUri}#delete`,
        type: "Delete",
        object: known.actorUri,
        to: [PUBLIC],
      }),
    ).toBe(202);

    expect(await limitRows("actor_uri", known.actorUri)).toBe(0);
  });
});

const adminAccount = async (actorUri: string): Promise<ApiAdminAccountJSON> => {
  const response = await adminFetch(
    `/api/v1/admin/accounts/${RemoteAccountId.encode(actorUri)}`,
    "GET",
  );
  expect(response.status).toBe(200);
  return ApiAdminAccount.parse(await response.json());
};

const listedUris = async (response: Response): Promise<string[]> => {
  expect(response.status).toBe(200);
  return z
    .array(ApiAdminAccount)
    .parse(await response.json())
    .map((account) => account.account.uri);
};

/** The actors v2's `origin=remote&status=…` lists on `domain`. */
const listedV2 = async (status: string, domain: string): Promise<string[]> =>
  listedUris(
    await adminFetch(
      `/api/v2/admin/accounts?origin=remote&status=${status}&by_domain=${domain}`,
      "GET",
    ),
  );

/** The actors v1's `remote` and status flag list on `domain`. */
const listedV1 = async (status: string, domain: string): Promise<string[]> =>
  listedUris(
    await adminFetch(
      `/api/v1/admin/accounts?remote=true&${status}=true&by_domain=${domain}`,
      "GET",
    ),
  );

const moderate = async (actorUri: string, action: string): Promise<ApiAdminAccountJSON> => {
  const response = await adminFetch(
    `/api/v1/admin/accounts/${RemoteAccountId.encode(actorUri)}/${action}`,
    "POST",
  );
  expect(response.status).toBe(200);
  return ApiAdminAccount.parse(await response.json());
};

/** A block saved again with its severity kept: Mastodon runs `DomainBlockWorker` again. */
const editBlock = (id: string, severity: Severity): Promise<void> =>
  settled(async () => {
    const response = await adminFetch(`/api/v1/admin/domain_blocks/${id}`, "PUT", {
      severity,
      public_comment: "edited",
    });
    expect(response.status).toBe(200);
  });

/**
 * Mastodon v4.7.5's admin views read `silenced_at` / `suspended_at`
 * (`REST::Admin::AccountSerializer#silenced`, `#suspended`, and
 * `AccountFilter#status_scope`), which a domain block sets on each account
 * it covers.
 */
describe("the admin account views of an actor a domain block limits", () => {
  it("show an actor a silence covers or keeps under a narrower noop as silenced", async () => {
    const { known } = await knownUnderNoop("adm-sil.example");
    const onDomain = await remoteActor("plain", "adm-sil.example");
    await block("adm-sil.example", "silence");

    for (const actor of [known, onDomain]) {
      expect(await adminAccount(actor.actorUri)).toMatchObject({
        silenced: true,
        suspended: false,
      });
    }
    expect(await listedV2("silenced", "open.adm-sil.example")).toEqual([known.actorUri]);
    expect(await listedV1("silenced", "open.adm-sil.example")).toEqual([known.actorUri]);
    expect(await listedV2("silenced", "adm-sil.example")).toEqual([onDomain.actorUri]);
    expect(await listedV2("active", "open.adm-sil.example")).toEqual([known.actorUri]);
    expect(await listedV2("suspended", "open.adm-sil.example")).toEqual([]);
  });

  it("show an actor a suspension keeps under a narrower noop as suspended", async () => {
    const { known } = await knownUnderNoop("adm-susp.example");
    await block("adm-susp.example", "suspend");

    expect(await adminAccount(known.actorUri)).toMatchObject({ suspended: true });
    expect(await listedV2("suspended", "open.adm-susp.example")).toEqual([known.actorUri]);
    expect(await listedV1("suspended", "open.adm-susp.example")).toEqual([known.actorUri]);
    expect(await listedV2("active", "open.adm-susp.example")).toEqual([]);
  });

  // `silenced_at` and `suspended_at` are apart: an actor can hold both, and
  // `AccountFilter`'s `silenced` lists a suspended one too.
  it("show a domain silence and an admin's suspension both", async () => {
    const { known } = await knownUnderNoop("mix-sil.example");
    await moderate(known.actorUri, "suspend");
    await block("mix-sil.example", "silence");

    expect(await adminAccount(known.actorUri)).toMatchObject({ silenced: true, suspended: true });
    expect(await listedV2("silenced", "open.mix-sil.example")).toEqual([known.actorUri]);
    expect(await listedV2("suspended", "open.mix-sil.example")).toEqual([known.actorUri]);
  });

  it("show an admin's silence and a domain suspension both", async () => {
    const { known } = await knownUnderNoop("mix-susp.example");
    await moderate(known.actorUri, "silence");
    await block("mix-susp.example", "suspend");

    expect(await adminAccount(known.actorUri)).toMatchObject({ silenced: true, suspended: true });
    expect(await listedV2("silenced", "open.mix-susp.example")).toEqual([known.actorUri]);
    expect(await listedV2("suspended", "open.mix-susp.example")).toEqual([known.actorUri]);
  });
});

/**
 * Mastodon v4.7.5's `Api::V1::Admin::AccountsController#unsilence` and
 * `#unsuspend` clear the account's `silenced_at` / `suspended_at`, whoever set
 * them. Any later run of `DomainBlockWorker` (every create or update of the
 * block, whatever changed) limits it again: `process_domain_block!` sets them
 * on each account `without_silenced` / `without_suspended`.
 */
describe("lifting a domain block's limitation of one actor", () => {
  it("unsilences the actor until the block is saved again", async () => {
    const { known, note } = await knownUnderNoop("lift-one-sil.example");
    const onDomain = await remoteActor("plain", "lift-one-sil.example");
    const id = await block("lift-one-sil.example", "silence");

    expect(await moderate(known.actorUri, "unsilence")).toMatchObject({ silenced: false });
    expect(await moderate(onDomain.actorUri, "unsilence")).toMatchObject({ silenced: false });

    expect(await publicRemoteUris()).toContain(note);
    expect(await silencedAuthors([known.actorUri, onDomain.actorUri])).toEqual([]);
    expect(await listedV2("silenced", "open.lift-one-sil.example")).toEqual([]);

    await editBlock(id, "silence");

    expect(await adminAccount(known.actorUri)).toMatchObject({ silenced: true });
    expect(await adminAccount(onDomain.actorUri)).toMatchObject({ silenced: true });
    expect(await publicRemoteUris()).not.toContain(note);
  });

  it("unsuspends the actor, and a change to a silence silences it", async () => {
    const { known, note } = await knownUnderNoop("lift-one-susp.example");
    const id = await block("lift-one-susp.example", "suspend");

    expect(await moderate(known.actorUri, "unsilence")).toMatchObject({ suspended: true });
    expect(await moderate(known.actorUri, "unsuspend")).toMatchObject({ suspended: false });

    expect(await lookup("known@open.lift-one-susp.example")).toBe("Shown");
    const after = "https://open.lift-one-susp.example/notes/after";
    expect(await createNote(known, after)).toBe(202);
    // `DeleteAccountService` deleted what the account had when suspended;
    // what it posts after the unsuspension shows.
    const shown = await publicRemoteUris();
    expect(shown).toContain(after);
    expect(shown).not.toContain(note);

    await changeBlock(id, "silence");

    expect(await adminAccount(known.actorUri)).toMatchObject({
      silenced: true,
      suspended: false,
    });
  });

  it("keeps the admin's own silence when a domain suspension is lifted", async () => {
    const { known } = await knownUnderNoop("own-sil.example");
    await moderate(known.actorUri, "silence");
    await block("own-sil.example", "suspend");
    expect(await adminAccount(known.actorUri)).toMatchObject({ silenced: true, suspended: true });

    expect(await moderate(known.actorUri, "unsuspend")).toMatchObject({
      silenced: true,
      suspended: false,
    });
  });

  it("forgets the lift with the actor's own account Delete", async () => {
    const { known } = await knownUnderNoop("lift-del.example");
    await block("lift-del.example", "silence");
    await moderate(known.actorUri, "unsilence");
    expect(await liftRows(known.actorUri)).toBe(1);

    expect(
      await known.send({
        id: `${known.actorUri}#delete`,
        type: "Delete",
        object: known.actorUri,
        to: [PUBLIC],
      }),
    ).toBe(202);

    expect(await liftRows(known.actorUri)).toBe(0);
  });

  it("forgets the lift with the block", async () => {
    const { known } = await knownUnderNoop("lift-gone.example");
    const id = await block("lift-gone.example", "silence");
    await moderate(known.actorUri, "unsilence");

    await unblock(id);

    const row = await env.DB.prepare(
      "SELECT count(*) AS n FROM remote_actor_domain_lifts WHERE domain_block_id = ?",
    )
      .bind(id)
      .first();
    expect(z.object({ n: z.number() }).parse(row).n).toBe(0);
  });
});

const liftRows = async (actorUri: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM remote_actor_domain_lifts WHERE actor_uri = ?",
  )
    .bind(actorUri)
    .first();
  return z.object({ n: z.number() }).parse(row).n;
};

const VIEWER = "domain-limits-viewer@example.com";

const viewerFetch = async (path: string, init?: RequestInit): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(await authHeaders(VIEWER)),
    },
  });

/** `GET /api/v1/accounts/:id`: 404, or whether it renders `suspended`. */
const accountById = async (actorUri: string): Promise<"NotFound" | "Suspended" | "Shown"> => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`,
  );
  expect([200, 404]).toContain(response.status);
  if (response.status === 404) {
    return "NotFound";
  }
  const { suspended } = z
    .object({ suspended: z.boolean().optional() })
    .parse(await response.json());
  return suspended === true ? "Suspended" : "Shown";
};

const accountStatusUris = async (actorUri: string): Promise<string[]> => {
  const response = await viewerFetch(
    `/api/v1/accounts/${RemoteAccountId.encode(actorUri)}/statuses`,
  );
  expect(response.status).toBe(200);
  return z
    .array(z.object({ uri: z.string() }))
    .parse(await response.json())
    .map((status) => status.uri);
};

const relationshipIds = async (actorUri: string): Promise<string[]> => {
  const response = await viewerFetch(
    `/api/v1/accounts/relationships?id[]=${RemoteAccountId.encode(actorUri)}`,
  );
  expect(response.status).toBe(200);
  return z
    .array(z.object({ id: z.string() }))
    .parse(await response.json())
    .map((relationship) => relationship.id);
};

const searchedAccountUris = async (q: string): Promise<string[]> => {
  const response = await viewerFetch(
    `/api/v2/search?type=accounts&resolve=true&q=${encodeURIComponent(q)}`,
  );
  expect(response.status).toBe(200);
  return z
    .object({ accounts: z.array(z.object({ url: z.string(), uri: z.string().optional() })) })
    .parse(await response.json())
    .accounts.map((account) => account.uri ?? account.url);
};

const notificationSenders = async (): Promise<string[]> => {
  const response = await viewerFetch("/api/v1/notifications");
  expect(response.status).toBe(200);
  return z
    .array(z.object({ account: z.object({ id: z.string() }) }))
    .parse(await response.json())
    .map((notification) => notification.account.id);
};

/** An actor on `domain` that posted a public note and liked the viewer's status. */
const knownOnDomain = async (
  domain: string,
): Promise<Readonly<{ actor: Remote; note: string }>> => {
  const actor = await remoteActor("plain", domain);
  const note = `https://${domain}/notes/before`;
  expect(await createNote(actor, note)).toBe(202);
  const posted = await viewerFetch("/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status: `liked from ${domain}` }),
  });
  expect(posted.status).toBe(200);
  const { uri } = z.object({ uri: z.string() }).parse(await posted.json());
  expect(
    await actor.send({ id: `${actor.actorUri}#like`, type: "Like", object: uri, to: [PUBLIC] }),
  ).toBe(202);
  expect(await accountStatusUris(actor.actorUri)).toEqual([note]);
  expect(await notificationSenders()).toContain(RemoteAccountId.encode(actor.actorUri));
  return { actor, note };
};

/**
 * Mastodon v4.7.5 refuses an account on a domain a suspension covers only at
 * `domain_not_allowed?`: `ResolveAccountService` (account lookup, search's
 * `resolve`), the inbox and signed fetches. Elsewhere the account is a record
 * like any other: `Api::V1::AccountsController#set_account` finds it by id
 * and `REST::AccountSerializer` renders it `suspended: true`, with the
 * statuses, favourites and notifications `BlockDomainService` deleted. Its
 * per-account `unsuspend!` clears `suspended_at`, so it renders again, its
 * domain still refused.
 */
describe("an actor on a host a suspension covers", () => {
  it("renders suspended by id, with nothing it posted, and is refused by lookup", async () => {
    const { actor, note } = await knownOnDomain("host-susp.example");
    const id = RemoteAccountId.encode(actor.actorUri);

    await block("host-susp.example", "suspend");

    expect(await accountById(actor.actorUri)).toBe("Suspended");
    expect(await relationshipIds(actor.actorUri)).toEqual([id]);
    expect(await accountStatusUris(actor.actorUri)).toEqual([]);
    expect(await publicRemoteUris()).not.toContain(note);
    expect(await notificationSenders()).not.toContain(id);
    expect(await lookup("plain@host-susp.example")).toBe("NotFound");
    expect(await searchedAccountUris("plain@host-susp.example")).toEqual([]);
    expect(await createNote(actor, "https://host-susp.example/notes/after")).toBe(403);
  });

  it("renders again once an admin unsuspends it, its domain still refused", async () => {
    const { actor, note } = await knownOnDomain("host-lift.example");
    const id = await block("host-lift.example", "suspend");

    expect(await moderate(actor.actorUri, "unsuspend")).toMatchObject({ suspended: false });

    expect(await liftRows(actor.actorUri)).toBe(1);
    expect(await accountById(actor.actorUri)).toBe("Shown");
    expect(await listedV2("suspended", "host-lift.example")).toEqual([]);
    // `DeleteAccountService` deleted what the account had when suspended.
    expect(await accountStatusUris(actor.actorUri)).toEqual([]);
    expect(await publicRemoteUris()).not.toContain(note);
    expect(await notificationSenders()).not.toContain(RemoteAccountId.encode(actor.actorUri));
    expect(await lookup("plain@host-lift.example")).toBe("NotFound");
    expect(await createNote(actor, "https://host-lift.example/notes/after")).toBe(403);

    await editBlock(id, "suspend");

    expect(await accountById(actor.actorUri)).toBe("Suspended");
    expect(await adminAccount(actor.actorUri)).toMatchObject({ suspended: true });
  });
});

describe("a silence or suspension made before its actors were recorded", () => {
  it("records the actors first seen by its last change, from the hourly sweep", async () => {
    await block("open.old-susp.example", "noop");
    const before = await remoteActor("before", "open.old-susp.example");
    const after = await remoteActor("after", "open.old-susp.example");
    const firstSeen = (actorUri: string, at: string) =>
      env.DB.prepare("UPDATE remote_actors SET created_at = ? WHERE actor_uri = ?").bind(
        at,
        actorUri,
      );
    // A block stored before migration 0169, as migration 0171 finds it.
    const id = "old-susp-block";
    await env.DB.batch([
      firstSeen(before.actorUri, "2026-01-01T00:00:00.000Z"),
      firstSeen(after.actorUri, "2026-03-01T00:00:00.000Z"),
      env.DB.prepare(
        `INSERT INTO domain_blocks (id, domain, severity, created_at, updated_at)
         VALUES (?, 'old-susp.example', 'suspend', '2025-12-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
      ).bind(id),
      env.DB.prepare(
        "INSERT INTO domain_block_limit_backfills (domain_block_id, seen_by) VALUES (?, ?)",
      ).bind(id, "2026-02-01T00:00:00.000Z"),
    ]);

    await settled(async () => {
      expect(await processOutboxJob(env, { kind: "ResumeLiftedDomainBlockLimits" })).toBe("ok");
    });

    expect(await limitRows("actor_uri", before.actorUri)).toBe(1);
    expect(await limitRows("actor_uri", after.actorUri)).toBe(0);
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM domain_block_limit_backfills",
    ).first();
    expect(z.object({ n: z.number() }).parse(left).n).toBe(0);
  });

  it("is not started again while a chain holds its claim", async () => {
    const actor = await remoteActor("claimed", "claimed-susp.example");
    const id = "claimed-susp-block";
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO domain_blocks (id, domain, severity, created_at, updated_at)
         VALUES (?, 'claimed-susp.example', 'suspend', ?, ?)`,
      ).bind(id, now, now),
      env.DB.prepare(
        `INSERT INTO domain_block_limit_backfills (domain_block_id, seen_by, claimed_at)
         VALUES (?, ?, ?)`,
      ).bind(id, now, now),
    ]);
    const sweep = () =>
      settled(async () => {
        expect(await processOutboxJob(env, { kind: "ResumeLiftedDomainBlockLimits" })).toBe("ok");
      });

    await sweep();
    expect(await limitRows("actor_uri", actor.actorUri)).toBe(0);

    // A claim no page stamped for an hour is a chain that stopped.
    await env.DB.prepare("UPDATE domain_block_limit_backfills SET claimed_at = ?")
      .bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
      .run();
    await sweep();
    expect(await limitRows("actor_uri", actor.actorUri)).toBe(1);
  });
});

describe("the admin page of an actor a domain silence limits", () => {
  it("shows it limited and lifts the limit from its button", async () => {
    const { known, note } = await knownUnderNoop("page-sil.example");
    await block("page-sil.example", "silence");
    const { fetcher } = await signUp("page_sil_admin");
    await env.DB.prepare(
      `UPDATE "user" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE username = ?)`,
    )
      .bind("page_sil_admin")
      .run();
    const path = `/admin/accounts/${RemoteAccountId.encode(known.actorUri)}`;

    const html = await (await fetcher(path)).text();
    expect(html).toContain("State: limited");
    expect(html).toContain("Lift limit");

    expect((await postForm(fetcher, path, { do: "unsilence" })).status).toBe(303);
    expect(await adminAccount(known.actorUri)).toMatchObject({ silenced: false });
    expect(await publicRemoteUris()).toContain(note);
  });
});
