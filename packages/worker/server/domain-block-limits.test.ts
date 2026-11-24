import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { ApiAdminAccount, type ApiAdminAccountJSON } from "@tstodon/api";
import { CoveredHosts, IsoInstant, OutboxJob, RemoteActor } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { postForm, signUp } from "../test/passkey-browser";
import { patchD1 } from "../test/meter";
import {
  drainHeld,
  holdQueue,
  kindOf,
  QUEUE_INVOCATION_BUDGET,
  withQueueDrained,
} from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { webfingerAnswer } from "../test/webfinger-fixture";
import {
  listDomainBlockLimits,
  listLimitingDomainBlockIds,
  RECORD_PAGE_SQL,
} from "./domain-block-limits";
import { unsignedFetch } from "./federated-fetch";
import { listUnfollowedSilencedAuthorsJson } from "./generated/prisma/sql";
import { generateAccountKeys } from "./keys";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";
import { refreshRemoteActor } from "./remote-actor-fetch";
import { listStaleRemoteActorUris, profileKept, upsertRemoteActor } from "./remote-actor-store";
import { parseInstanceIdentity } from "./runtime-config";
import {
  SUSPENDED_CONTENT_BOOST_PAGE,
  SUSPENDED_CONTENT_FINISHED_PAGE,
  SUSPENDED_CONTENT_PAGE,
  startSuspendedActorContentPurge,
} from "./suspended-actor-content";
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

const HeldRow = z.object({ actor_uri: z.string(), block_id: z.string(), severity: z.string() });

// The readers seek the blocks by each host's parent domains; after every
// scenario here they must find what the view `remote_actor_domain_rules`
// yields for every cached actor.
afterEach(async () => {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT actor_uri, domain_block_id AS block_id, severity FROM remote_actor_domain_rules
     WHERE severity IN ('silence', 'suspend')`,
  ).all();
  const view = z.array(HeldRow).parse(results);
  const actors = await env.DB.prepare("SELECT actor_uri FROM remote_actors").all();
  const uris = z
    .array(z.object({ actor_uri: z.string() }))
    .parse(actors.results)
    .map((row) => row.actor_uri);
  const limits = (await listDomainBlockLimits(env.DB, uris))._unsafeUnwrap();
  const fromView = new Map<string, { silenced: boolean; suspended: boolean }>();
  for (const row of view) {
    const held = fromView.get(row.actor_uri) ?? { silenced: false, suspended: false };
    fromView.set(row.actor_uri, {
      silenced: held.silenced || row.severity === "silence",
      suspended: held.suspended || row.severity === "suspend",
    });
  }
  expect(new Map(limits)).toEqual(fromView);
  for (const severity of ["silence", "suspend"] as const) {
    for (const uri of new Set(view.map((row) => row.actor_uri))) {
      const ids = (await listLimitingDomainBlockIds(env.DB, uri, severity))._unsafeUnwrap();
      expect(ids.toSorted()).toEqual(
        [
          ...new Set(
            view
              .filter((row) => row.actor_uri === uri && row.severity === severity)
              .map((row) => row.block_id),
          ),
        ].toSorted(),
      );
    }
  }
});

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
  withQueueDrained(["RecordDomainBlockLimits", "PurgeSuspendedActorContent"], work);

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

    // `DeleteAccountService` deleted what the account had when suspended.
    expect(await publicRemoteUris()).not.toContain(note);
    expect(await lookup("known@open.lift-susp.example")).toBe("Shown");
    const after = "https://open.lift-susp.example/notes/after";
    expect(await createNote(known, after)).toBe(202);
    expect(await publicRemoteUris()).toContain(after);
  });

  it("lifts the suspension when the block becomes a noop", async () => {
    const { known, note } = await knownUnderNoop("noop-susp.example");
    const id = await block("noop-susp.example", "suspend");

    await changeBlock(id, "noop");

    expect(await publicRemoteUris()).not.toContain(note);
    const after = "https://open.noop-susp.example/notes/after";
    expect(await createNote(known, after)).toBe(202);
    expect(await publicRemoteUris()).toContain(after);
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
  it("seeks the account domain key's index in its own order", async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${RECORD_PAGE_SQL}`)
      .bind("block", "com.example.", "com.example/", "com.example.a.", 7, 500)
      .all();
    const details = z
      .array(z.object({ detail: z.string() }))
      .parse(results)
      .map((row) => row.detail);
    expect(details.join("\n")).toMatch(/^SEARCH remote_actors USING (COVERING )?INDEX /);
    expect(details.filter((detail) => /^SCAN |TEMP B-TREE/.test(detail))).toEqual([]);
  });
});

describe("the rule an actor is recorded under when first cached", () => {
  // The trigger runs on every new actor: it seeks the actor, then each parent
  // domain of its account domain, never the actors or the blocks in full.
  it("is read by index seeks only", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT domain_block_id FROM remote_actor_account_domain_rule
       WHERE actor_uri = ?`,
    )
      .bind("https://a.example.com/users/a")
      .all();
    const details = z
      .array(z.object({ detail: z.string() }))
      .parse(results)
      .map((row) => row.detail);
    expect(
      details.filter((detail) => /SCAN (r|d|remote_actors|domain_blocks)\b/.test(detail)),
    ).toEqual([]);
    expect(details.join("\n")).toMatch(
      /SEARCH d USING (COVERING )?INDEX idx_domain_blocks_domain_key/,
    );
  });
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

const statusRows = async (actorUri: string): Promise<number> => {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM remote_statuses WHERE actor_uri = ?")
    .bind(actorUri)
    .first();
  return z.object({ n: z.number() }).parse(row).n;
};

/** The viewer's boost of the actor's only status, after the actor boosts a viewer post. */
const boostedBothWays = async (actor: Remote): Promise<string> => {
  const statuses = await viewerFetch(
    `/api/v1/accounts/${RemoteAccountId.encode(actor.actorUri)}/statuses`,
  );
  const [status] = z.array(z.object({ id: z.string() })).parse(await statuses.json());
  const reblog = await viewerFetch(`/api/v1/statuses/${status?.id}/reblog`, { method: "POST" });
  expect(reblog.status).toBe(200);
  const posted = await viewerFetch("/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status: "boosted from afar" }),
  });
  const { uri } = z.object({ uri: z.string() }).parse(await posted.json());
  expect(
    await actor.send({
      id: `${actor.actorUri}/boosts/1`,
      type: "Announce",
      object: uri,
      published: "2026-11-01T00:00:00.000Z",
      to: [PUBLIC],
      cc: [`${actor.actorUri}/followers`],
    }),
  ).toBe(202);
  expect(await accountStatusUris(actor.actorUri)).toHaveLength(2);
  return z.object({ id: z.string() }).parse(await reblog.json()).id;
};

/** A suspension stored with its actors recorded and their content kept, as migration 0176 queues it. */
const recordedSuspension = (id: string, domain: string, actorUris: ReadonlyArray<string>) => {
  const at = "2026-11-01T00:00:00.000Z";
  return env.DB.batch([
    env.DB.prepare(
      `INSERT INTO domain_blocks (id, domain, severity, created_at, updated_at)
       VALUES (?, ?, 'suspend', ?, ?)`,
    ).bind(id, domain, at, at),
    ...actorUris.map((uri) =>
      env.DB.prepare(
        "INSERT INTO remote_actor_domain_limits (domain_block_id, actor_uri) VALUES (?, ?)",
      ).bind(id, uri),
    ),
    env.DB.prepare(
      "INSERT INTO domain_block_limit_backfills (domain_block_id, seen_by) VALUES (?, ?)",
    ).bind(id, at),
  ]);
};

const hourlySweep = () =>
  settled(async () => {
    expect(await processOutboxJob(env, { kind: "ResumeLiftedDomainBlockLimits" })).toBe("ok");
  });

/**
 * Mastodon v4.7.5's `BlockDomainService#suspend_accounts!` runs
 * `DeleteAccountService` with `reserve_username` on each account it
 * suspends: its statuses (with their mentions, media, polls and the reblogs
 * of them), its own reblogs, favourites and the notifications it generated
 * are deleted, and the account row is kept with `suspended_at`. Changing the
 * block to a silence or a `noop`, or removing it, clears `suspended_at` and
 * restores none of them; what the account sends afterwards is stored again.
 */
describe("the content a domain suspension emptied", () => {
  it.each([
    ["changed to a silence", "empty-sil.example", (id: string) => changeBlock(id, "silence")],
    ["changed to a noop", "empty-noop.example", (id: string) => changeBlock(id, "noop")],
    ["removed", "empty-gone.example", unblock],
  ])("stays gone when the block is %s", async (_, domain, lift) => {
    const { actor, note } = await knownOnDomain(domain);
    const reblogId = await boostedBothWays(actor);
    const id = await block(domain, "suspend");

    await lift(id);

    expect(await accountStatusUris(actor.actorUri)).toEqual([]);
    expect(await notificationSenders()).not.toContain(RemoteAccountId.encode(actor.actorUri));
    expect((await viewerFetch(`/api/v1/statuses/${reblogId}`)).status).toBe(404);
    expect(await publicRemoteUris()).not.toContain(note);
    const after = `https://${domain}/notes/after`;
    expect(await createNote(actor, after)).toBe(202);
    expect(await accountStatusUris(actor.actorUri)).toEqual([after]);
  });

  it(
    "empties an actor with many statuses in bounded queue pages",
    { timeout: 60_000 },
    async () => {
      const domain = "empty-many.example";
      const actor = await remoteActor("many", domain);
      const count = SUSPENDED_CONTENT_PAGE * 2 + 7;
      await env.DB.prepare(
        `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ?2)
       INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at)
       SELECT printf('%d', 900000000000 + n), ?1, ?3 || n, '<p>bulk</p>', 'public',
              '2026-11-01T00:00:00.000Z'
       FROM series`,
      )
        .bind(actor.actorUri, count, `https://${domain}/notes/`)
        .run();
      patchD1();
      const queued = holdQueue();
      let most = 0;
      try {
        const response = await adminFetch("/api/v1/admin/domain_blocks", "POST", {
          domain,
          severity: "suspend",
        });
        expect(response.status).toBe(200);
        most = await drainHeld(queued, ["RecordDomainBlockLimits"]);
        expect(await statusRows(actor.actorUri)).toBe(count);
        // One page deletes one page of statuses and queues the next.
        expect(await processOutboxJob(env, { kind: "PurgeSuspendedActorContent" })).toBe("ok");
        expect(await statusRows(actor.actorUri)).toBe(count - SUSPENDED_CONTENT_PAGE);
        most = Math.max(most, await drainHeld(queued, ["PurgeSuspendedActorContent"]));
      } finally {
        queued.release();
      }

      expect(await statusRows(actor.actorUri)).toBe(0);
      expect(most, `one queue invocation made ${most} statements`).toBeLessThan(
        QUEUE_INVOCATION_BUDGET,
      );
    },
  );

  it("announces a bounded number of local boosts a page", { timeout: 60_000 }, async () => {
    const { actor } = await knownOnDomain("empty-boosts.example");
    const reblogId = await boostedBothWays(actor);
    const count = SUSPENDED_CONTENT_BOOST_PAGE * 2 + 3;
    await env.DB.prepare(
      `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ?2)
       INSERT INTO statuses (id, account_id, kind, reblog_of_id, reblog_of_remote_id, content_text,
                             content_html, visibility, sensitive, spoiler_text, created_at, updated_at)
       SELECT printf('%d', 910000000000 + n), s.account_id, 'LocalReblog', NULL, s.reblog_of_remote_id,
              '', '', 'public', 0, '', s.created_at, s.updated_at
       FROM series CROSS JOIN statuses s WHERE s.id = ?1`,
    )
      .bind(reblogId, count - 1)
      .run();
    const localBoosts = async (): Promise<number> => {
      const row = await env.DB.prepare(
        `SELECT count(*) AS n FROM statuses s JOIN remote_statuses r ON r.id = s.reblog_of_remote_id
         WHERE r.actor_uri = ?`,
      )
        .bind(actor.actorUri)
        .first();
      return z.object({ n: z.number() }).parse(row).n;
    };
    expect(await localBoosts()).toBe(count);
    patchD1();
    const queued = holdQueue();
    let most = 0;
    try {
      const response = await adminFetch("/api/v1/admin/domain_blocks", "POST", {
        domain: "empty-boosts.example",
        severity: "suspend",
      });
      expect(response.status).toBe(200);
      most = await drainHeld(queued, ["RecordDomainBlockLimits"]);
      expect(await processOutboxJob(env, { kind: "PurgeSuspendedActorContent" })).toBe("ok");
      // The status waits for a later page, until its last local boost is gone.
      expect(await localBoosts()).toBe(count - SUSPENDED_CONTENT_BOOST_PAGE);
      expect(await statusRows(actor.actorUri)).toBe(1);
      most = Math.max(most, await drainHeld(queued, ["PurgeSuspendedActorContent"]));
    } finally {
      queued.release();
    }

    expect(await localBoosts()).toBe(0);
    expect(await statusRows(actor.actorUri)).toBe(0);
    expect(most, `one queue invocation made ${most} statements`).toBeLessThan(
      QUEUE_INVOCATION_BUDGET,
    );
  });

  it("starts no second chain while one holds the lease", async () => {
    const actor = await remoteActor("leased", "empty-lease.example");
    await env.DB.prepare(
      "INSERT INTO remote_actor_content_purges (actor_uri, before) VALUES (?, ?)",
    )
      .bind(actor.actorUri, new Date().toISOString())
      .run();
    const queued = holdQueue();
    const started = () =>
      queued.bodies.filter((body) => kindOf(body) === "PurgeSuspendedActorContent").length;
    try {
      await startSuspendedActorContentPurge(env);
      await startSuspendedActorContentPurge(env);
      expect(started()).toBe(1);

      // A lease no page stamped for ten minutes is a chain that stopped.
      await env.DB.prepare("UPDATE remote_actor_content_purge_lease SET stamped_at = ?")
        .bind(new Date(Date.now() - 11 * 60 * 1000).toISOString())
        .run();
      await startSuspendedActorContentPurge(env);
      expect(started()).toBe(2);

      // The last page gives the lease back.
      expect(await processOutboxJob(env, { kind: "PurgeSuspendedActorContent" })).toBe("ok");
      const lease = await env.DB.prepare(
        "SELECT count(*) AS n FROM remote_actor_content_purge_lease",
      ).first();
      expect(z.object({ n: z.number() }).parse(lease).n).toBe(0);
    } finally {
      queued.release();
    }
  });

  it("keeps what an actor an admin suspended first had", async () => {
    const { actor } = await knownOnDomain("empty-own.example");
    await moderate(actor.actorUri, "suspend");

    await block("empty-own.example", "suspend");

    expect(await statusRows(actor.actorUri)).toBe(1);
  });

  it("is emptied by the hourly sweep for a suspension recorded before", async () => {
    const { actor } = await knownOnDomain("empty-old.example");
    const id = "empty-old-block";
    await recordedSuspension(id, "empty-old.example", [actor.actorUri]);
    expect(await statusRows(actor.actorUri)).toBe(1);

    await hourlySweep();

    expect(await statusRows(actor.actorUri)).toBe(0);
    await changeBlock(id, "silence");
    expect(await accountStatusUris(actor.actorUri)).toEqual([]);
    expect(await notificationSenders()).not.toContain(RemoteAccountId.encode(actor.actorUri));
  });

  it("is not emptied again by the sweep for an actor an admin unsuspended", async () => {
    const actor = await remoteActor("lifted", "empty-lifted.example");
    expect(await createNote(actor, "https://empty-lifted.example/notes/since")).toBe(202);
    const id = "empty-lifted-block";
    await recordedSuspension(id, "empty-lifted.example", [actor.actorUri]);
    await env.DB.prepare(
      `INSERT INTO remote_actor_domain_lifts (domain_block_id, actor_uri, severity)
       VALUES (?, ?, 'suspend')`,
    )
      .bind(id, actor.actorUri)
      .run();

    await hourlySweep();

    expect(await statusRows(actor.actorUri)).toBe(1);
  });
});

const purgeRows = async (actorUri: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM remote_actor_content_purges WHERE actor_uri = ?",
  )
    .bind(actorUri)
    .first();
  return z.object({ n: z.number() }).parse(row).n;
};

const Held = z.object({
  blocking: z.boolean(),
  muting: z.boolean(),
  endorsed: z.boolean(),
  blocked_by: z.boolean(),
});

/** What the viewer and the actor hold of each other, as the viewer's relationship and lists show it. */
const heldOf = async (actorUri: string) => {
  const id = RemoteAccountId.encode(actorUri);
  const response = await viewerFetch(`/api/v1/accounts/relationships?id[]=${id}`);
  expect(response.status).toBe(200);
  const [relationship] = z.array(Held).parse(await response.json());
  const listed = async (path: string): Promise<boolean> => {
    const page = await viewerFetch(path);
    expect(page.status).toBe(200);
    return z
      .array(z.object({ id: z.string() }))
      .parse(await page.json())
      .some((account) => account.id === id);
  };
  return {
    ...relationship,
    listed: {
      blocks: await listed("/api/v1/blocks"),
      mutes: await listed("/api/v1/mutes"),
      endorsements: await listed("/api/v1/endorsements"),
    },
  };
};

const NOTHING_HELD = {
  blocking: false,
  muting: false,
  endorsed: false,
  blocked_by: false,
  listed: { blocks: false, mutes: false, endorsements: false },
};

/** The viewer blocks, mutes and endorses the actor, and the actor blocks the viewer. */
const heldBothWays = async (actor: Remote): Promise<void> => {
  const me = await viewerFetch("/api/v1/accounts/verify_credentials");
  const { username } = z.object({ username: z.string() }).parse(await me.json());
  expect(
    await actor.send({
      id: `${actor.actorUri}#blocks/viewer`,
      type: "Block",
      object: `https://example.com/users/${username}`,
    }),
  ).toBe(202);
  const id = RemoteAccountId.encode(actor.actorUri);
  for (const action of ["endorse", "mute", "block"]) {
    expect((await viewerFetch(`/api/v1/accounts/${id}/${action}`, { method: "POST" })).status).toBe(
      200,
    );
  }
  expect(await heldOf(actor.actorUri)).toEqual(ALL_HELD);
};

const ALL_HELD = {
  blocking: true,
  muting: true,
  endorsed: true,
  blocked_by: true,
  listed: { blocks: true, mutes: true, endorsements: true },
};

/** A purge of the actor queued with the cut-off `before`, as a recording page writes it. */
const queuePurge = async (actorUri: string, before: string): Promise<void> => {
  await env.DB.prepare("INSERT INTO remote_actor_content_purges (actor_uri, before) VALUES (?, ?)")
    .bind(actorUri, before)
    .run();
};

/** The actor features `#Cats`, as its outbox backfill stores it. */
const featureTag = async (actorUri: string): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO remote_featured_tags (actor_uri, tag_name, name, position) VALUES (?, 'cats', 'Cats', 0)",
  )
    .bind(actorUri)
    .run();
};

/** `GET /api/v1/accounts/:id/featured_tags`. */
const featuredTagNames = async (actorUri: string): Promise<string[]> => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${RemoteAccountId.encode(actorUri)}/featured_tags`,
  );
  expect(response.status).toBe(200);
  return z
    .array(z.object({ name: z.string() }))
    .parse(await response.json())
    .map((tag) => tag.name);
};

const ShownProfile = z.object({
  display_name: z.string(),
  note: z.string(),
  fields: z.array(z.object({ name: z.string() })),
  avatar: z.string(),
  header: z.string(),
});

/** `GET /api/v1/accounts/:id`'s profile of the actor. */
const shownProfile = async (actorUri: string) => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`,
  );
  expect(response.status).toBe(200);
  return ShownProfile.parse(await response.json());
};

/** A cached actor with a full profile; called again, a fetch of it. */
const profiledActor = (domain: string): Promise<Remote> =>
  remoteActor("profiled", domain, {
    note: "hello from afar",
    avatarUrl: `https://${domain}/avatar.png`,
    headerUrl: `https://${domain}/header.png`,
    fields: [{ name: "Site", value: "elsewhere" }],
  });

const expectFullProfile = async (domain: string, actorUri: string): Promise<void> => {
  expect(await shownProfile(actorUri)).toMatchObject({
    display_name: "Remote profiled",
    note: expect.stringContaining("hello from afar"),
    fields: [{ name: "Site" }],
    avatar: `https://${domain}/avatar.png`,
    header: `https://${domain}/header.png`,
  });
};

/** Serve each of `actors`' documents with `profiledActor`'s profile, and its WebFinger. */
const serveProfiledActors = (actors: ReadonlyArray<Remote>) => {
  const documents = Object.fromEntries(
    actors.map((actor) => {
      const host = new URL(actor.actorUri).host;
      return [
        actor.actorUri,
        {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: actor.actorUri,
          type: "Person",
          preferredUsername: "profiled",
          name: "Remote profiled",
          summary: "<p>hello from afar</p>",
          inbox: `${actor.actorUri}/inbox`,
          icon: { type: "Image", url: `https://${host}/avatar.png` },
          image: { type: "Image", url: `https://${host}/header.png` },
          attachment: [{ type: "PropertyValue", name: "Site", value: "elsewhere" }],
          publicKey: {
            id: `${actor.actorUri}#main-key`,
            owner: actor.actorUri,
            publicKeyPem: actor.publicKeyPem,
          },
        },
      ];
    }),
  );
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/.well-known/webfinger") {
      return webfingerAnswer(documents, url);
    }
    const document = documents[url.href];
    return document
      ? Response.json(document, { headers: { "content-type": "application/activity+json" } })
      : new Response(null, { status: 404 });
  });
};

const expectPurgedProfile = async (domain: string, actorUri: string): Promise<void> => {
  const shown = await shownProfile(actorUri);
  expect(shown).toMatchObject({ display_name: "", note: "", fields: [] });
  expect(shown.avatar).not.toBe(`https://${domain}/avatar.png`);
  expect(shown.header).not.toBe(`https://${domain}/header.png`);
};

const heldRows = async (actorUri: string) => {
  const row = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM blocks WHERE target_actor_uri = ?1) AS blocks,
            (SELECT count(*) FROM mutes WHERE target_actor_uri = ?1) AS mutes,
            (SELECT count(*) FROM endorsements WHERE target_actor_uri = ?1) AS endorsements`,
  )
    .bind(actorUri)
    .first();
  return z.object({ blocks: z.number(), mutes: z.number(), endorsements: z.number() }).parse(row);
};

/**
 * Mastodon v4.7.5's `DeleteAccountService` with `reserve_username` also
 * deletes what local accounts hold of the account (`blocked_by_relationships`,
 * `muted_by_relationships`, and the endorsements its follows' removal takes,
 * `Follow#remove_endorsements`) and its blocks of them
 * (`block_relationships`), and clears its profile (`purge_profile!`) until a
 * later fetch fills it again. None of it comes back when the block is
 * lifted.
 */
describe("what local accounts held of an actor a domain suspension emptied", () => {
  it.each([
    ["changed to a noop", "held-noop.example", (id: string) => changeBlock(id, "noop")],
    ["removed", "held-gone.example", unblock],
  ])("stays gone when the block is %s", async (_, domain, lift) => {
    const actor = await remoteActor("plain", domain);
    await heldBothWays(actor);
    const id = await block(domain, "suspend");

    await lift(id);

    expect(await heldOf(actor.actorUri)).toEqual(NOTHING_HELD);
  });

  it("leaves its profile empty after a lift until it is fetched again", async () => {
    const domain = "held-profile.example";
    const actor = await profiledActor(domain);
    await featureTag(actor.actorUri);
    await expectFullProfile(domain, actor.actorUri);
    expect(await featuredTagNames(actor.actorUri)).toEqual(["Cats"]);
    const id = await block(domain, "suspend");

    await changeBlock(id, "noop");

    expect(await accountById(actor.actorUri)).toBe("Shown");
    await expectPurgedProfile(domain, actor.actorUri);
    expect(await featuredTagNames(actor.actorUri)).toEqual([]);
    await profiledActor(domain);
    await expectFullProfile(domain, actor.actorUri);
  });

  // `ProcessAccountService#update_account` skips `set_immediate_attributes!`
  // and `set_fetchable_attributes!` for a suspended account.
  it("keeps its profile empty when it is fetched during the suspension", async () => {
    const domain = "held-refetch.example";
    const host = `open.${domain}`;
    await block(host, "noop");
    const actor = await profiledActor(host);
    const id = await block(domain, "suspend");

    await profiledActor(host);
    await changeBlock(id, "noop");

    expect(await accountById(actor.actorUri)).toBe("Shown");
    await expectPurgedProfile(host, actor.actorUri);
    await profiledActor(host);
    await expectFullProfile(host, actor.actorUri);
  });

  // `set_immediate_protocol_attributes!` still writes `url`, `actor_type` and
  // `created_at`; `set_immediate_attributes!` (the featured collection) and,
  // for a local suspension, `set_fetchable_key!` are skipped; so is the
  // profile's emoji.
  it("writes only a suspended actor's protocol attributes when it is fetched", async () => {
    const domain = "held-protocol.example";
    const host = `open.${domain}`;
    await block(host, "noop");
    const actor = await remoteActor("proto", host, { featuredUri: `https://${host}/featured` });
    await block(domain, "suspend");
    const rotated = await generateAccountKeys();
    const document = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: actor.actorUri,
      type: "Service",
      preferredUsername: "proto",
      name: "Renamed :owl:",
      url: `https://${host}/@proto`,
      published: "2020-01-02T00:00:00Z",
      inbox: `${actor.actorUri}/inbox`,
      featured: `https://${host}/featured-moved`,
      tag: [
        {
          type: "Emoji",
          name: ":owl:",
          icon: { type: "Image", mediaType: "image/png", url: `https://${host}/owl.png` },
        },
      ],
      publicKey: {
        id: `${actor.actorUri}#main-key`,
        owner: actor.actorUri,
        publicKeyPem: rotated.publicKeyPem,
      },
    };
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/.well-known/webfinger") {
        return webfingerAnswer({ [actor.actorUri]: document }, url);
      }
      return url.href === actor.actorUri
        ? Response.json(document, { headers: { "content-type": "application/activity+json" } })
        : new Response(null, { status: 404 });
    });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    try {
      const refreshed = await refreshRemoteActor(env.DB, identity, actor.actorUri, {
        allowHosts: new Set<string>(),
        blockedHosts: CoveredHosts.none,
        fetchSigner: unsignedFetch,
      });
      expect(refreshed.isOk()).toBe(true);
    } finally {
      fetched.mockRestore();
    }

    const stored = await env.DB.prepare(
      `SELECT r.display_name, r.featured_uri, k.public_key_pem,
              (SELECT count(*) FROM remote_custom_emojis WHERE domain = ?2) AS emojis
       FROM remote_actors r JOIN remote_actor_keys k ON k.actor_uri = r.actor_uri
       WHERE r.actor_uri = ?1`,
    )
      .bind(actor.actorUri, host)
      .first();
    // The suspension's purge emptied the name; the fetch did not write it back.
    expect(stored).toEqual({
      display_name: "",
      featured_uri: `https://${host}/featured`,
      public_key_pem: actor.publicKeyPem,
      emojis: 0,
    });
    const { results } = await env.DB.prepare(
      "SELECT profile_json FROM remote_actors WHERE actor_uri = ?",
    )
      .bind(actor.actorUri)
      .all();
    const profile = z
      .array(z.object({ profile_json: z.string() }))
      .parse(results)
      .map((row) => z.record(z.string(), z.unknown()).parse(JSON.parse(row.profile_json)))[0];
    expect(profile).toMatchObject({
      profileUrl: `https://${host}/@proto`,
      bot: true,
      publishedAt: "2020-01-02T00:00:00.000Z",
      emojis: [],
    });
  });

  it("is returned as stored by the write of a fetch during the suspension", async () => {
    const domain = "held-returned.example";
    const actor = await profiledActor(domain);
    await moderate(actor.actorUri, "suspend");
    const fetched = RemoteActor.fromFetched({
      actorUri: actor.actorUri,
      username: "profiled",
      domain,
      inboxUri: `${actor.actorUri}/inbox`,
      displayName: "Renamed",
      profile: RemoteActor.emptyProfile,
      fetchedAt: IsoInstant.parse(new Date(Date.now() + 1000).toISOString())._unsafeUnwrap(),
    })._unsafeUnwrap();

    const written = (await upsertRemoteActor(env.DB, fetched, []))._unsafeUnwrap();

    expect(written.displayName).toBe("Remote profiled");
    expect(written.profile.note).toBe("hello from afar");
    expect(profileKept(fetched, written)).toBe(true);
  });

  // `refresh_remote_account!` clears `last_webfingered_at`, so a refetch the
  // queue lost is the hourly refresh's.
  it("makes an unsuspended actor due the hourly refresh", async () => {
    const actor = await remoteActor("due", "held-due.example", {
      accountDomain: "due.example",
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });
    await env.DB.prepare("UPDATE remote_actors SET refresh_attempted_at = ? WHERE actor_uri = ?")
      .bind(new Date().toISOString(), actor.actorUri)
      .run();
    await moderate(actor.actorUri, "suspend");

    await withQueueDrained([], () => moderate(actor.actorUri, "unsuspend"));

    const due = (await listStaleRemoteActorUris(env.DB, 1000))._unsafeUnwrap();
    expect(due).toContain(actor.actorUri);
  });

  // `UnsuspendAccountService` runs only for an account that was suspended.
  it("queues no fetch when an admin unsuspends an actor nothing suspended", async () => {
    const domain = "held-never.example";
    const actor = await profiledActor(domain);
    await block(domain, "silence");
    const queued = holdQueue();
    try {
      await moderate(actor.actorUri, "unsuspend");
    } finally {
      queued.release();
    }

    expect(queued.bodies.map(kindOf)).not.toContain("RefreshRemoteActor");
  });

  it("keeps the profile an admin suspension found when it is fetched meanwhile", async () => {
    const domain = "held-own-refetch.example";
    const actor = await profiledActor(domain);
    await moderate(actor.actorUri, "suspend");

    await remoteActor("profiled", domain, { note: "changed while suspended" });
    // The refetch the unsuspension queues is dropped.
    await withQueueDrained([], () => moderate(actor.actorUri, "unsuspend"));

    await expectFullProfile(domain, actor.actorUri);
  });

  // `UnsuspendAccountService#refresh_remote_account!` resolves the account
  // straight away; `ProcessAccountService` refuses one `domain_not_allowed?`.
  it("gets its profile back from the fetch an admin's unsuspension makes at once", async () => {
    const domain = "held-unsuspend.example";
    const host = `open.${domain}`;
    await block(host, "noop");
    const actor = await profiledActor(host);
    const covered = await profiledActor(`covered.${domain}`);
    await block(domain, "suspend");
    await expectPurgedProfile(host, actor.actorUri);
    const fetched = serveProfiledActors([actor, covered]);
    let asked: URL[] = [];

    try {
      await withQueueDrained(["RefreshRemoteActor"], async () => {
        await moderate(actor.actorUri, "unsuspend");
        await moderate(covered.actorUri, "unsuspend");
      });
      asked = fetched.mock.calls.map(([input, init]) => new URL(new Request(input, init).url));
    } finally {
      fetched.mockRestore();
    }

    await expectFullProfile(host, actor.actorUri);
    await expectPurgedProfile(`covered.${domain}`, covered.actorUri);
    expect(asked.some((url) => url.href === actor.actorUri)).toBe(true);
    expect(asked.filter((url) => url.host === `covered.${domain}`)).toEqual([]);
  });

  it("is emptied by the hourly sweep for a suspension recorded before", async () => {
    const domain = "held-old.example";
    const actor = await profiledActor(domain);
    await heldBothWays(actor);
    const id = "held-old-block";
    await recordedSuspension(id, domain, [actor.actorUri]);

    await hourlySweep();
    await changeBlock(id, "noop");

    expect(await heldOf(actor.actorUri)).toEqual(NOTHING_HELD);
    await expectPurgedProfile(domain, actor.actorUri);
  });

  it("is emptied by an admin's unsuspension of an actor whose purge is queued", async () => {
    const domain = "held-lift.example";
    const actor = await profiledActor(domain);
    await heldBothWays(actor);
    await recordedSuspension("held-lift-block", domain, [actor.actorUri]);
    await queuePurge(actor.actorUri, new Date().toISOString());

    expect(await moderate(actor.actorUri, "unsuspend")).toMatchObject({ suspended: false });

    expect(await purgeRows(actor.actorUri)).toBe(0);
    expect(await heldOf(actor.actorUri)).toEqual(NOTHING_HELD);
    await expectPurgedProfile(domain, actor.actorUri);
  });

  it("keeps a block made during the suspension when an admin unsuspends the actor", async () => {
    const domain = "held-during.example";
    const actor = await remoteActor("plain", domain);
    await block(domain, "suspend");
    const id = RemoteAccountId.encode(actor.actorUri);
    expect((await viewerFetch(`/api/v1/accounts/${id}/block`, { method: "POST" })).status).toBe(
      200,
    );

    expect(await moderate(actor.actorUri, "unsuspend")).toMatchObject({ suspended: false });

    expect(await heldOf(actor.actorUri)).toMatchObject({ blocking: true });
  });

  it("keeps everything of an actor an admin suspended first, when unsuspended", async () => {
    const domain = "held-own.example";
    const actor = await profiledActor(domain);
    await heldBothWays(actor);
    await moderate(actor.actorUri, "suspend");
    await block(domain, "suspend");

    expect(await moderate(actor.actorUri, "unsuspend")).toMatchObject({ suspended: false });

    expect(await heldOf(actor.actorUri)).toEqual(ALL_HELD);
    await expectFullProfile(domain, actor.actorUri);
  });

  it("finishes many purges with nothing left a page at a time", async () => {
    const count = SUSPENDED_CONTENT_FINISHED_PAGE + 7;
    await env.DB.prepare(
      `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ?1)
       INSERT INTO remote_actor_content_purges (actor_uri, before)
       SELECT 'https://held-done.example/users/u' || n, ?2 FROM series`,
    )
      .bind(count, new Date().toISOString())
      .run();
    const left = async (): Promise<number> => {
      const row = await env.DB.prepare(
        "SELECT count(*) AS n FROM remote_actor_content_purges WHERE actor_uri LIKE 'https://held-done.example/%'",
      ).first();
      return z.object({ n: z.number() }).parse(row).n;
    };

    expect(await processOutboxJob(env, { kind: "PurgeSuspendedActorContent" })).toBe("ok");
    expect(await left()).toBe(7);
    expect(await processOutboxJob(env, { kind: "PurgeSuspendedActorContent" })).toBe("ok");
    expect(await left()).toBe(0);
  });

  it(
    "deletes many blocks, mutes and endorsements of it in bounded queue pages",
    { timeout: 60_000 },
    async () => {
      const domain = "held-many.example";
      const actor = await remoteActor("many", domain);
      const count = SUSPENDED_CONTENT_PAGE * 2 + 7;
      const series = `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < ?2)`;
      const holders = `SELECT 'held-many-' || n, ?1 FROM series`;
      await env.DB.batch([
        env.DB.prepare(
          `${series}
           INSERT INTO accounts (id, username, access_email, display_name, public_key_pem, private_key_jwk)
           SELECT 'held-many-' || n, 'heldmany' || n, 'held-many-' || n || '@example.com', '', '', ''
           FROM series WHERE ?1 IS NOT NULL`,
        ).bind(actor.actorUri, count),
        ...[
          "blocks (blocker_account_id, target_actor_uri)",
          "mutes (account_id, target_actor_uri)",
          "endorsements (account_id, target_actor_uri)",
        ].map((into) =>
          env.DB.prepare(`${series} INSERT INTO ${into} ${holders}`).bind(actor.actorUri, count),
        ),
      ]);
      expect(await heldRows(actor.actorUri)).toEqual({
        blocks: count,
        mutes: count,
        endorsements: count,
      });
      patchD1();
      const queued = holdQueue();
      let most = 0;
      try {
        const response = await adminFetch("/api/v1/admin/domain_blocks", "POST", {
          domain,
          severity: "suspend",
        });
        expect(response.status).toBe(200);
        most = await drainHeld(queued, ["RecordDomainBlockLimits"]);
        // One page deletes one page of each and queues the next.
        expect(await processOutboxJob(env, { kind: "PurgeSuspendedActorContent" })).toBe("ok");
        const left = count - SUSPENDED_CONTENT_PAGE;
        expect(await heldRows(actor.actorUri)).toEqual({
          blocks: left,
          mutes: left,
          endorsements: left,
        });
        most = Math.max(most, await drainHeld(queued, ["PurgeSuspendedActorContent"]));
      } finally {
        queued.release();
      }

      expect(await heldRows(actor.actorUri)).toEqual({ blocks: 0, mutes: 0, endorsements: 0 });
      expect(await purgeRows(actor.actorUri)).toBe(0);
      expect(most, `one queue invocation made ${most} statements`).toBeLessThan(
        QUEUE_INVOCATION_BUDGET,
      );
    },
  );

  it("keeps what was made, and a profile fetched, after its purge's cut-off", async () => {
    const domain = "held-after.example";
    const actor = await profiledActor(domain);
    await featureTag(actor.actorUri);
    await queuePurge(actor.actorUri, "2026-01-01T00:00:00.000Z");
    await heldBothWays(actor);

    expect(await processOutboxJob(env, { kind: "PurgeSuspendedActorContent" })).toBe("ok");

    expect(await purgeRows(actor.actorUri)).toBe(0);
    expect(await heldOf(actor.actorUri)).toEqual(ALL_HELD);
    await expectFullProfile(domain, actor.actorUri);
    expect(await featuredTagNames(actor.actorUri)).toEqual(["Cats"]);
  });
});

// `ActivityPub::ProcessAccountService#create_account` sets `suspended_at` /
// `silenced_at` from `DomainBlock.rule_for(@domain)`, and a narrower rule
// made later leaves them. Under a silence or suspension, the admin API makes
// a narrower `noop` only as a stricter block changed to one (`#create`
// compares rules, `#update` does not).
const narrowerNoop = async (domain: string): Promise<void> => {
  await changeBlock(await block(domain, "suspend"), "noop");
};

describe("an actor first cached under a silence or suspension of its domain", () => {
  it("stays suspended when a narrower noop is made later", async () => {
    await block("late-cached.example", "suspend");
    const later = await remoteActor("later", "open.late-cached.example");
    expect(await limitRows("actor_uri", later.actorUri)).toBe(1);
    expect(await purgeRows(later.actorUri)).toBe(0);

    await narrowerNoop("open.late-cached.example");
    // A write of a suspended actor stores no key, as `set_fetchable_key!` is
    // skipped; the key is cached here so the inbox reaches the suspension.
    await env.DB.prepare(
      "INSERT INTO remote_actor_keys (key_id, actor_uri, type, public_key_pem) VALUES (?, ?, 'rsa', ?)",
    )
      .bind(`${later.actorUri}#main-key`, later.actorUri, later.publicKeyPem)
      .run();

    expect(await lookup("later@open.late-cached.example")).toBe("Suspended");
    expect(await accountById(later.actorUri)).toBe("Suspended");
    expect(await createNote(later, "https://open.late-cached.example/notes/1")).toBe(403);
  });

  it("stays silenced when a narrower noop is made later", async () => {
    await block("late-sil.example", "silence");
    const later = await remoteActor("later", "open.late-sil.example");

    await narrowerNoop("open.late-sil.example");

    expect(await silencedAuthors([later.actorUri])).toEqual([later.actorUri]);
    expect(await adminAccount(later.actorUri)).toMatchObject({ silenced: true });
  });

  it("is recorded once however often it is fetched again", async () => {
    await block("late-again.example", "silence");
    const actor = await remoteActor("again", "late-again.example");
    await remoteActor("again", "late-again.example");

    expect(await limitRows("actor_uri", actor.actorUri)).toBe(1);
  });

  it("is recorded under the most specific rule only", async () => {
    await block("late-noop.example", "suspend");
    await narrowerNoop("open.late-noop.example");
    const later = await remoteActor("later", "open.late-noop.example");

    expect(await limitRows("actor_uri", later.actorUri)).toBe(0);
    expect(await lookup("later@open.late-noop.example")).toBe("Shown");
  });

  it("is not recorded when only its URI's host is blocked", async () => {
    await block("late-uri.example", "silence");
    const actor = await remoteActor("later", "late-uri.example", {
      accountDomain: "open-late-uri.example",
    });

    expect(await limitRows("actor_uri", actor.actorUri)).toBe(0);
  });
});

// `Account.by_domain_and_subdomains` matches the account domain only, so
// `BlockDomainService` neither suspends nor empties an account whose account
// domain the block does not cover, wherever its actor URI is.
describe("an actor whose URI's host a suspension covers and whose account domain is open", () => {
  it("is not recorded, and keeps its content once the block is removed", async () => {
    const actor = await remoteActor("split", "media.uri-susp.example", {
      accountDomain: "open-uri-susp.example",
    });
    const note = "https://media.uri-susp.example/notes/before";
    expect(await createNote(actor, note)).toBe(202);

    const id = await block("uri-susp.example", "suspend");

    expect(await limitRows("actor_uri", actor.actorUri)).toBe(0);
    expect(await purgeRows(actor.actorUri)).toBe(0);
    expect(await statusRows(actor.actorUri)).toBe(1);
    // Known divergence: presentation also suspends an actor by its URI's host.
    expect(await accountById(actor.actorUri)).toBe("Suspended");

    await unblock(id);

    expect(await accountById(actor.actorUri)).toBe("Shown");
    expect(await publicRemoteUris()).toContain(note);
  });
});

describe("a recording job queued while the URI hosts were read too", () => {
  it("ends its chain at a UriHost cursor, keeping the admin's lifts", async () => {
    const { actor } = await knownOnDomain("legacy-cursor.example");
    const id = await block("legacy-cursor.example", "suspend");
    expect(await moderate(actor.actorUri, "unsuspend")).toMatchObject({ suspended: false });
    const queued = OutboxJob.parse({
      kind: "RecordDomainBlockLimits",
      domainBlockId: id,
      cursor: { host: "UriHost", afterKey: "", afterRowId: 0 },
      run: { kind: "Apply" },
    })._unsafeUnwrap();

    await settled(async () => {
      expect(await processOutboxJob(env, queued)).toBe("ok");
    });

    expect(await liftRows(actor.actorUri)).toBe(1);
    expect(await accountById(actor.actorUri)).toBe("Shown");
  });
});
