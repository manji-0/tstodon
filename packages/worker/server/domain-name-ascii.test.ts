import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult, Sensitive } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
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
    // The unblock finds nothing to remove: the row is stored in Unicode.
    expect(await call(USER, "DELETE", "/api/v1/domain_blocks?domain=konto-ü.example")).toBe(404);
    expect(
      await rows(
        "SELECT domain FROM account_domain_blocks WHERE account_id = ?1 ORDER BY domain",
        account,
      ),
    ).toEqual([["beide-ü.example"], ["konto-ü.example"], ["xn--beide--8ya.example"]]);

    // Three a page puts both spellings of `doppel-ü.example` in the first one.
    let page = await asciiDomainNames(env.DB, 3);
    while (page.isOk() && page.value.chained) {
      page = await asciiDomainNames(env.DB, 3);
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
    expect(await asciiDomainNames(env.DB)).toMatchObject({
      value: { scanned: 0, renamed: 0, chained: false },
    });
  });
});
