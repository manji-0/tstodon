import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { mediaRejectedDomains, suspendedDomains } from "./admin-domain-block-store";
import { domainAllowHosts } from "./domain-allow-store";

const allowed = async (): Promise<ReadonlySet<string>> =>
  (await domainAllowHosts(env.DB)).unwrapOr(new Set(["read failed"]));

/**
 * The domain lists are kept between reads in an isolate; every write to their
 * tables, by any statement, must show in the next read.
 */
describe("domain policy lists after writes", () => {
  it("follows each insert, update and delete of a domain block", async () => {
    expect([...(await suspendedDomains(env.DB))]).toEqual([]);
    expect([...(await mediaRejectedDomains(env.DB))]).toEqual([]);

    await env.DB.prepare(
      `INSERT INTO domain_blocks (id, domain, severity, reject_media, created_at)
       VALUES ('revision-block', 'Blocked.Example:8443', 'suspend', 0, '2026-11-01T00:00:00.000Z')`,
    ).run();
    expect([...(await suspendedDomains(env.DB))]).toEqual(["blocked.example"]);
    expect([...(await mediaRejectedDomains(env.DB))]).toEqual([]);

    await env.DB.prepare(
      "UPDATE domain_blocks SET severity = 'silence', reject_media = 1 WHERE id = 'revision-block'",
    ).run();
    expect([...(await suspendedDomains(env.DB))]).toEqual([]);
    expect([...(await mediaRejectedDomains(env.DB))]).toEqual(["blocked.example"]);

    await env.DB.prepare("DELETE FROM domain_blocks WHERE id = 'revision-block'").run();
    expect([...(await mediaRejectedDomains(env.DB))]).toEqual([]);
  });

  it("follows each insert, update and delete of a domain allow", async () => {
    expect([...(await allowed())]).toEqual([]);

    await env.DB.prepare(
      `INSERT INTO domain_allows (id, domain, created_at)
       VALUES ('revision-allow', 'allowed.example', '2026-11-01T00:00:00.000Z')`,
    ).run();
    expect([...(await allowed())]).toEqual(["allowed.example"]);

    await env.DB.prepare(
      "UPDATE domain_allows SET domain = 'other.example' WHERE id = 'revision-allow'",
    ).run();
    expect([...(await allowed())]).toEqual(["other.example"]);

    await env.DB.prepare("DELETE FROM domain_allows WHERE id = 'revision-allow'").run();
    expect([...(await allowed())]).toEqual([]);
  });
});
