import { env } from "cloudflare:test";
import { Hostname } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { DOMAIN_RESTRICTED_ACTORS_SQL } from "./domain-hidden-actors";
import {
  clearRemoteMediaForDomain,
  listKnownRemoteInboxes,
  listRemoteNoteReplies,
  searchRemoteActors,
} from "./generated/prisma/sql";
import { hostKeyRange } from "./host-key";
import { d1PrepareTyped, type TypedSqlLike } from "./typed-sql";

const plan = async (typed: TypedSqlLike): Promise<string[]> => {
  const { results } = await d1PrepareTyped(env.DB, {
    sql: `EXPLAIN QUERY PLAN ${typed.sql}`,
    values: typed.values,
  }).all();
  return z
    .array(z.object({ detail: z.string() }))
    .parse(results)
    .map((row) => row.detail);
};

const range = hostKeyRange(Hostname.ofAuthority("example.com"));

/**
 * A domain rule covers its subdomains through `remote_actor_domain_rules`
 * (migration 0163): each rule is read once and the actors it covers are one
 * range of a host key index, so no statement reads every actor or every rule
 * per actor to apply them.
 */
describe("statements that apply instance domain rules", () => {
  it.each([
    [
      "the hidden actors of a timeline",
      { sql: `SELECT * FROM ${DOMAIN_RESTRICTED_ACTORS_SQL.replace("?", "$1")}`, values: [""] },
    ],
    ["a note's replies", listRemoteNoteReplies("https://example.com/notes/1", "", 20)],
    ["account search", searchRemoteActors("bob", "[]", 20, 0)],
  ])("seeks the actors each rule covers by host key in %s", async (_, typed) => {
    const details = await plan(typed);

    // Account search reads every actor's name by design; the rules never scan.
    expect(details.filter((detail) => /^SCAN (r|d|n|domain_blocks)\b/.test(detail))).toEqual([]);
    expect(details).toContainEqual(expect.stringMatching(/USING INDEX idx_remote_actors_host_key/));
    expect(details).toContainEqual(
      expect.stringMatching(/USING INDEX idx_remote_actors_uri_host_key/),
    );
  });

  it("walks the actors once for the known inboxes, and the rules by host key", async () => {
    const details = await plan(listKnownRemoteInboxes(100));

    expect(details.filter((detail) => /^SCAN (d|n|domain_blocks)\b/.test(detail))).toEqual([]);
    expect(details).toContainEqual(expect.stringMatching(/USING INDEX idx_remote_actors_host_key/));
  });

  it("seeks a domain's actors and its subdomains' by host key range when clearing media", async () => {
    const details = await plan(clearRemoteMediaForDomain(range.from, range.to, "now"));

    expect(details.filter((detail) => /^SCAN remote_actors\b/.test(detail))).toEqual([]);
    expect(details).toContainEqual(
      expect.stringMatching(/idx_remote_actors_host_key \(host_key>\? AND host_key<\?\)/),
    );
    expect(details).toContainEqual(
      expect.stringMatching(
        /idx_remote_actors_uri_host_key \(uri_host_key>\? AND uri_host_key<\?\)/,
      ),
    );
  });
});
