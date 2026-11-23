import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult, Sensitive } from "@tstodon/core";
import { OutboxJob, type OutboxJobValue } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { asciiDomainNames } from "./domain-name-ascii";
import { processOutboxJob } from "./outbox-job";
import { isRegistrationBlocked } from "./registration-block-store";

const ADMIN = "idn-admin@example.com";
const USER = "idn-user@example.com";

const call = async (
  email: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<number> => {
  const headers = await authHeaders(email, { admin: email === ADMIN });
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await response.body?.cancel();
  return response.status;
};

const blocked = async (email: string): Promise<boolean> =>
  (await isRegistrationBlocked(env.DB, Sensitive.of(email))).unwrapOr(false);

const rows = async (sql: string, ...binds: unknown[]): Promise<unknown[][]> => {
  const { results } = await env.DB.prepare(sql)
    .bind(...binds)
    .all();
  return parseRows(z.record(z.string(), z.unknown()), results).map((row) => Object.values(row));
};

const accountId = async (email: string): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  const parsed = schemaResult(z.object({ id: z.string() }))(await response.json());
  if (parsed.isErr()) {
    throw new Error("no account");
  }
  return parsed.value.id;
};

describe("an email domain block, as EmailDomainBlock::Matcher", () => {
  it("refuses an address at an internationalized domain blocked in Unicode", async () => {
    expect(
      await call(ADMIN, "POST", "/api/v1/admin/email_domain_blocks", { domain: "bücher.de" }),
    ).toBe(200);
    expect(await blocked("a@bücher.de")).toBe(true);
    expect(await blocked("a@BÜCHER.DE")).toBe(true);
    expect(await blocked("a@xn--bcher-kva.de")).toBe(true);
    expect(await blocked("a@buecher.de")).toBe(false);
  });

  it("refuses an address at a subdomain of a blocked domain (domain_variants)", async () => {
    expect(
      await call(ADMIN, "POST", "/api/v1/admin/email_domain_blocks", {
        domain: "mail-parent.example",
      }),
    ).toBe(200);
    expect(await blocked("a@mx.mail-parent.example")).toBe(true);
    expect(await blocked("a@other-mail-parent.example")).toBe(false);
  });
});

/** Rows written before `Hostname.fromInput` stored an internationalized name in its ASCII form. */
const seedLegacyRows = async (account: string): Promise<void> => {
  await env.DB.batch([
    // A Unicode block alone is renamed; one beside its ASCII form merges into it.
    env.DB.prepare(
      `INSERT INTO domain_blocks (id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at)
       VALUES ('idn-lone', 'einzel-ü.example', 'silence', 0, 0, 0, 'old note', NULL, '2020-01-01T00:00:00.000Z'),
              ('idn-old', 'doppel-ü.example', 'suspend', 1, 0, 1, 'old note', 'old public', '2020-01-01T00:00:00.000Z'),
              ('idn-new', 'xn--doppel--t2a.example', 'silence', 0, 1, 0, NULL, 'new public', '2024-01-01T00:00:00.000Z'),
              ('idn-dot', 'doppel-ü.example。', 'noop', 0, 0, 0, NULL, NULL, '2019-01-01T00:00:00.000Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO account_domain_blocks (account_id, domain, created_at)
       VALUES (?1, 'konto-ü.example', '2020-01-01T00:00:00.000Z'),
              (?1, 'beide-ü.example', '2020-01-01T00:00:00.000Z'),
              (?1, 'xn--beide--8ya.example', '2024-01-01T00:00:00.000Z')`,
    ).bind(account),
    env.DB.prepare(
      `INSERT INTO domain_allows (id, domain, created_at)
       VALUES ('idn-allow-old', 'erlaubt-ü.example', '2020-01-01T00:00:00.000Z'),
              ('idn-allow-new', 'xn--erlaubt--e6a.example', '2024-01-01T00:00:00.000Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO email_domain_blocks (id, domain, created_at)
       VALUES ('idn-mail', 'post-ü.example', '2020-01-01T00:00:00.000Z')`,
    ),
  ]);
};

describe("asciiDomainNames", () => {
  it("rewrites the domains stored in Unicode to their ASCII form, merging into a row already there", async () => {
    const account = await accountId(USER);
    await seedLegacyRows(account);
    // The unblock finds nothing to remove: the row is stored in Unicode. It
    // answers 200 all the same, as Mastodon's.
    expect(await call(USER, "DELETE", "/api/v1/domain_blocks?domain=konto-ü.example")).toBe(200);
    expect(
      await rows(
        "SELECT domain FROM account_domain_blocks WHERE account_id = ?1 ORDER BY domain",
        account,
      ),
    ).toEqual([["beide-ü.example"], ["konto-ü.example"], ["xn--beide--8ya.example"]]);

    // Three a page puts both spellings of `doppel-ü.example` in the first one.
    let page = await asciiDomainNames(env, 3);
    while (page.isOk() && page.value.chained) {
      page = await asciiDomainNames(env, 3);
    }
    expect(page.isOk()).toBe(true);

    expect(
      await rows(
        `SELECT id, domain, severity, reject_media, reject_reports, obfuscate, private_comment, public_comment, created_at
         FROM domain_blocks WHERE id LIKE 'idn-%' ORDER BY id`,
      ),
    ).toEqual([
      [
        "idn-lone",
        "xn--einzel--t2a.example",
        "silence",
        0,
        0,
        0,
        "old note",
        null,
        "2020-01-01T00:00:00.000Z",
      ],
      // The strictest of the merged rules, the ASCII row's id and comments, the oldest time.
      [
        "idn-new",
        "xn--doppel--t2a.example",
        "suspend",
        1,
        1,
        1,
        "old note",
        "new public",
        "2019-01-01T00:00:00.000Z",
      ],
    ]);
    // The renamed block's `domain_key` follows its new name (migration 0163's trigger).
    expect(
      await rows(
        `SELECT b.domain_key = k.key FROM domain_blocks b
         JOIN host_keys k ON k.source = 'domain' AND k.id = b.id WHERE b.id IN ('idn-lone', 'idn-new')`,
      ),
    ).toEqual([[1], [1]]);

    expect(
      await rows(
        "SELECT domain, created_at FROM account_domain_blocks WHERE account_id = ?1 ORDER BY domain",
        account,
      ),
    ).toEqual([
      ["xn--beide--8ya.example", "2020-01-01T00:00:00.000Z"],
      ["xn--konto--8ya.example", "2020-01-01T00:00:00.000Z"],
    ]);
    expect(
      await rows("SELECT id, domain, created_at FROM domain_allows WHERE id LIKE 'idn-%'"),
    ).toEqual([["idn-allow-new", "xn--erlaubt--e6a.example", "2020-01-01T00:00:00.000Z"]]);
    expect(await rows("SELECT domain FROM email_domain_blocks WHERE id = 'idn-mail'")).toEqual([
      ["xn--post--ova.example"],
    ]);

    // The rows are reached by the names people type again.
    expect(await call(USER, "DELETE", "/api/v1/domain_blocks?domain=konto-ü.example")).toBe(200);
    expect(
      await rows("SELECT domain FROM account_domain_blocks WHERE account_id = ?1", account),
    ).toEqual([["xn--beide--8ya.example"]]);
    expect(await blocked("a@post-ü.example")).toBe(true);

    // Once complete, a run reads the cursor and stops.
    expect(await processOutboxJob(env, { kind: "AsciiDomainNames" })).toBe("ok");
    expect(await asciiDomainNames(env)).toMatchObject({
      value: { scanned: 0, renamed: 0, chained: false },
    });
  });
});

const QUEUED: QueueSendResponse = {
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

/** Run the rename from the start, then the jobs it queued, as the queue would. */
const renameAndRunQueued = async (): Promise<ReadonlyArray<OutboxJobValue>> => {
  await env.DB.prepare(
    "UPDATE backfill_cursors SET after_id = '', completed_at = NULL WHERE name = 'domain_name_ascii'",
  ).run();
  vi.restoreAllMocks();
  const send = vi.spyOn(env.OUTBOX_PROCESS_QUEUE, "send").mockResolvedValue(QUEUED);
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  let page = await asciiDomainNames(env);
  while (page.isOk() && page.value.chained) {
    page = await asciiDomainNames(env);
  }
  expect(page.isOk()).toBe(true);
  const queued = send.mock.calls.flatMap(([body]) => {
    const job = OutboxJob.parse(body);
    return job.isOk() && job.value.kind !== "AsciiDomainNames" ? [job.value] : [];
  });
  for (const job of queued) {
    expect(await processOutboxJob(env, job)).toBe("ok");
  }
  return queued;
};

const follows = async (account: string, actorUri: string): Promise<unknown[][]> =>
  rows(
    "SELECT state FROM outbound_follows WHERE account_id = ?1 AND actor_uri = ?2",
    account,
    actorUri,
  );

describe("asciiDomainNames switching a stored block on", () => {
  it("severs the local follows under a Unicode suspension once it names the ASCII host", async () => {
    const remote = await remoteActor("fern", "xn--fern--ova.example");
    const account = await accountId("idn-fern-follower@example.com");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO domain_blocks (id, domain, severity, reject_media, reject_reports, obfuscate, created_at)
         VALUES ('idn-fern', 'fern-ü.example', 'suspend', 0, 0, 0, '2020-01-01T00:00:00.000Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
         VALUES ('idn-fern-follow', ?1, ?2, ?2 || '#follows/idn', 'Accepted')`,
      ).bind(account, remote.actorUri),
    ]);
    expect(await follows(account, remote.actorUri)).toEqual([["Accepted"]]);

    await renameAndRunQueued();

    expect(await follows(account, remote.actorUri)).toEqual([]);
    expect(
      await rows(
        "SELECT type, target_name FROM relationship_severance_events WHERE target_name = 'xn--fern--ova.example'",
      ),
    ).toEqual([["domain_block", "xn--fern--ova.example"]]);

    // A second run finds nothing to rename and severs nothing again.
    const again = await renameAndRunQueued();
    expect(again).toEqual([]);
    expect(
      await rows(
        "SELECT count(*) FROM relationship_severance_events WHERE target_name = 'xn--fern--ova.example'",
      ),
    ).toEqual([[1]]);
  });

  it("severs a user's follows under their own Unicode domain block once it is renamed", async () => {
    const remote = await remoteActor("nutzer", "xn--nutzer--t2a.example");
    const account = await accountId("idn-nutzer@example.com");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_domain_blocks (account_id, domain, created_at)
         VALUES (?1, 'nutzer-ü.example', '2020-01-01T00:00:00.000Z')`,
      ).bind(account),
      env.DB.prepare(
        `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
         VALUES ('idn-nutzer-follow', ?1, ?2, ?2 || '#follows/idn', 'Accepted')`,
      ).bind(account, remote.actorUri),
    ]);

    const queued = await renameAndRunQueued();

    expect(queued).toEqual([
      expect.objectContaining({
        kind: "SeverBlockedDomainFollows",
        accountId: account,
        domain: "xn--nutzer--t2a.example",
      }),
    ]);
    expect(await follows(account, remote.actorUri)).toEqual([]);
  });

  it("keeps a renamed block's id, even where a new id would repeat it", async () => {
    const account = await accountId("idn-id-keeper@example.com");
    // The rename writes its row at the next rowid, 65536 above the old one:
    // the id migration 0166's trigger derives from the same `created_at`
    // would be the old row's.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO account_domain_blocks (rowid, account_id, domain, created_at)
         VALUES (1000001, ?1, 'zahl-ü.example', '2020-01-01T00:00:00.000Z')`,
      ).bind(account),
      env.DB.prepare(
        `INSERT INTO account_domain_blocks (rowid, account_id, domain, created_at)
         VALUES (1065536, ?1, 'filler.example', '2021-01-01T00:00:00.000Z')`,
      ).bind(account),
    ]);
    const [before] = await rows(
      "SELECT id FROM account_domain_blocks WHERE domain = 'zahl-ü.example'",
    );

    await renameAndRunQueued();

    expect(
      await rows("SELECT id FROM account_domain_blocks WHERE domain = 'xn--zahl--ova.example'"),
    ).toEqual([before]);
  });

  it("forgets the actors a merged block limited, keeping the kept block's", async () => {
    const remote = await remoteActor("lim", "xn--lim--3ra.example");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO domain_blocks (id, domain, severity, reject_media, reject_reports, obfuscate, created_at)
         VALUES ('idn-lim-old', 'lim-ü.example', 'suspend', 0, 0, 0, '2020-01-01T00:00:00.000Z'),
                ('idn-lim-kept', 'xn--lim--3ra.example', 'silence', 0, 0, 0, '2021-01-01T00:00:00.000Z')`,
      ),
      env.DB.prepare(
        `INSERT INTO remote_actor_domain_limits (domain_block_id, actor_uri)
         VALUES ('idn-lim-old', ?1), ('idn-lim-kept', ?1)`,
      ).bind(remote.actorUri),
    ]);

    await renameAndRunQueued();

    expect(
      await rows(
        "SELECT domain_block_id FROM remote_actor_domain_limits WHERE actor_uri = ? ORDER BY 1",
        remote.actorUri,
      ),
    ).toEqual([["idn-lim-kept"]]);
  });
});
