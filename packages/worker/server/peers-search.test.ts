import { SELF, env } from "cloudflare:test";
import { ApiPeerSearch } from "@tstodon/api";
import { describe, expect, it } from "vite-plus/test";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { z } from "zod";
import { searchPeerDomains as searchPeerDomainsSql } from "./generated/prisma/sql";
import { d1PrepareTyped } from "./typed-sql";

const search = async (q: string | undefined, headers: Record<string, string> = {}) => {
  const query = q === undefined ? "" : `?q=${encodeURIComponent(q)}`;
  return SELF.fetch(`https://example.com/api/v1/peers/search${query}`, { headers });
};

const domainsFor = async (q: string | undefined) => {
  const response = await search(q);
  expect(response.status).toBe(200);
  return expectContract(ApiPeerSearch, await response.json());
};

describe("GET /api/v1/peers/search", () => {
  it("lists known domains that start with q to an anonymous reader", async () => {
    await remoteActor("peer", "peersearch-b.example");
    await remoteActor("peer", "peersearch-a.example");
    await remoteActor("peer", "other-peersearch.example");

    expect(await domainsFor("peersearch")).toEqual([
      "peersearch-a.example",
      "peersearch-b.example",
    ]);
  });

  it("normalizes q as a host, as TagManager#normalize_domain", async () => {
    await remoteActor("peer", "peersearch-normal.example");

    expect(await domainsFor("  PeerSearch-Normal.Example/ ")).toEqual([
      "peersearch-normal.example",
    ]);
    expect(await domainsFor("peersearch-normal.example.")).toEqual(["peersearch-normal.example"]);
    expect(await domainsFor("\tpeersearch-normal\n\0")).toEqual(["peersearch-normal.example"]);
  });

  it("keeps a non-ASCII space, which Ruby's strip does not remove", async () => {
    await remoteActor("peer", "peersearch-nbsp.example");

    expect(await domainsFor(" peersearch-nbsp")).toEqual([]);
  });

  it("seeks remote actors by host instead of scanning them", async () => {
    const typed = searchPeerDomainsSql("peersearch", 10);
    const { results } = await d1PrepareTyped(env.DB, {
      sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
      values: typed.values,
    }).all();
    const details = z
      .array(z.object({ detail: z.string() }))
      .parse(results)
      .map((row) => row.detail);

    expect(details.filter((detail) => /^SCAN remote_actors\b/.test(detail))).toEqual([]);
    expect(
      details.some((detail) => /^SEARCH remote_actors .*\(host>\? AND host<\?\)/.test(detail)),
    ).toBe(true);
  });

  it("answers null when q is blank and no domains for a q that is not a host", async () => {
    expect(await domainsFor(undefined)).toBeNull();
    expect(await domainsFor("  ")).toBeNull();
    expect(await domainsFor("peer search")).toEqual([]);
    expect(await domainsFor("peer/search")).toEqual([]);
  });

  it("lists at most ten domains", async () => {
    for (let index = 0; index < 11; index += 1) {
      await remoteActor("peer", `peerlimit-${String(index).padStart(2, "0")}.example`);
    }

    const domains = await domainsFor("peerlimit-");

    expect(domains).toHaveLength(10);
  });

  it("leaves out a domain the instance blocks", async () => {
    await remoteActor("peer", "peerblocked.example");
    await remoteActor("peer", "peerblocked-not.example");
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('peersearch-block', 'peerblocked.example', 'suspend')",
    ).run();
    try {
      expect(await domainsFor("peerblocked")).toEqual(["peerblocked-not.example"]);
    } finally {
      await env.DB.prepare("DELETE FROM domain_blocks WHERE id = 'peersearch-block'").run();
    }
  });

  it("needs a user under limited federation, then is not found", async () => {
    await env.DB.prepare(
      "INSERT INTO domain_allows (id, domain, created_at) VALUES ('peersearch-allow', 'peersearch-a.example', '2026-01-01T00:00:00.000Z')",
    ).run();
    try {
      expect((await search("peersearch")).status).toBe(401);
      const signedIn = await search("peersearch", await authHeaders("peersearch@example.com"));
      expect(signedIn.status).toBe(404);
    } finally {
      await env.DB.prepare("DELETE FROM domain_allows WHERE id = 'peersearch-allow'").run();
    }
  });
});
