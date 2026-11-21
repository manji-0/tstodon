import { SELF, env } from "cloudflare:test";
import { CoveredHosts, Hostname } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { mediaRejectedDomains, suspendedDomains } from "./admin-domain-block-store";
import { admittedInboxes } from "./delivery";
import { listRemoteNoteReplies, listUnfollowedSilencedAuthorsJson } from "./generated/prisma/sql";
import { listKnownRemoteInboxes } from "./remote-actor-store";
import { d1PrepareTyped } from "./typed-sql";

/**
 * An instance domain rule covers the domain it names and every subdomain of
 * it, and a host follows its most specific rule, as Mastodon v4.7.5's
 * `DomainBlock.rule_for` (`domain_variants`, longest domain first). A user's
 * own domain block stays an exact match, as `Account#domain_blocking?`.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

type Severity = "silence" | "suspend" | "noop";

const rule = async (
  domain: string,
  severity: Severity,
  flags: Readonly<{ rejectMedia?: boolean }> = {},
): Promise<void> => {
  await env.DB.prepare(
    "INSERT INTO domain_blocks (id, domain, severity, reject_media) VALUES (?, ?, ?, ?)",
  )
    .bind(`rule-${domain}`, domain, severity, flags.rejectMedia ? 1 : 0)
    .run();
};

const host = Hostname.ofAuthority;

const remoteNote = async (remote: Remote, uri: string): Promise<string> => {
  expect(
    await remote.send({
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
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .first();
  return z.object({ id: z.string() }).parse(row).id;
};

const publicRemoteUris = async (headers: Record<string, string> = {}): Promise<string[]> => {
  const response = await SELF.fetch(
    "https://example.com/api/v1/timelines/public?remote=true&limit=40",
    { headers },
  );
  expect(response.status).toBe(200);
  return z
    .array(z.object({ uri: z.string() }))
    .parse(await response.json())
    .map((status) => status.uri);
};

describe("an instance silence of a parent domain", () => {
  it("hides its subdomains' posts from the public timeline unless a narrower rule lifts it", async () => {
    const sub = await remoteActor("silenced", "social.sil-parent.example");
    const exempt = await remoteActor("exempt", "open.sil-parent.example");
    const lookalike = await remoteActor("lookalike", "notsil-parent.example");
    const subNote = "https://social.sil-parent.example/notes/1";
    const exemptNote = "https://open.sil-parent.example/notes/1";
    const lookalikeNote = "https://notsil-parent.example/notes/1";
    await remoteNote(sub, subNote);
    await remoteNote(exempt, exemptNote);
    await remoteNote(lookalike, lookalikeNote);

    await rule("sil-parent.example", "silence");
    await rule("open.sil-parent.example", "noop");

    const uris = await publicRemoteUris();
    expect(uris).not.toContain(subNote);
    expect(uris).toContain(exemptNote);
    expect(uris).toContain(lookalikeNote);
  });

  it("marks a subdomain's author silenced for a viewer who does not follow it", async () => {
    const sub = await remoteActor("quiet", "a.quiet-parent.example");
    const exempt = await remoteActor("loud", "loud.quiet-parent.example");
    await rule("quiet-parent.example", "silence");
    await rule("loud.quiet-parent.example", "noop");

    const typed = listUnfollowedSilencedAuthorsJson(
      "",
      "[]",
      JSON.stringify([sub.actorUri, exempt.actorUri]),
    );
    const { results } = await d1PrepareTyped(env.DB, typed).all();
    expect(z.array(z.object({ author: z.string() })).parse(results)).toEqual([
      { author: sub.actorUri },
    ]);
  });
});

describe("a user's own domain block", () => {
  it("stays an exact match, as Account#domain_blocking?", async () => {
    const email = "subdomain-user-block@example.com";
    const sub = await remoteActor("unblocked", "social.user-parent.example");
    const subNote = "https://social.user-parent.example/notes/1";
    await remoteNote(sub, subNote);
    const headers = await authHeaders(email);
    const blocked = await SELF.fetch("https://example.com/api/v1/domain_blocks", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ domain: "user-parent.example" }),
    });
    expect(blocked.status).toBe(200);

    expect(await publicRemoteUris(headers)).toContain(subNote);
  });
});

describe("an instance suspension of a parent domain", () => {
  it("refuses deliveries from its subdomains unless a narrower rule lifts it", async () => {
    await rule("susp-parent.example", "suspend");
    await rule("open.susp-parent.example", "silence");
    const sub = await remoteActor("suspended", "social.susp-parent.example");
    const exempt = await remoteActor("exempt", "open.susp-parent.example");
    const like = (remote: Remote) => ({
      id: `${remote.actorUri}/likes/1`,
      type: "Like",
      object: "https://example.com/users/nobody/statuses/1",
    });

    expect(await sub.send(like(sub))).toBe(403);
    expect(await exempt.send(like(exempt))).not.toBe(403);
  });

  it("names the subdomains as suspended to the federation guards", async () => {
    await rule("guard-parent.example", "suspend");
    await rule("open.guard-parent.example", "noop");
    const suspended = await suspendedDomains(env.DB);

    expect(CoveredHosts.covers(suspended, host("guard-parent.example"))).toBe(true);
    expect(CoveredHosts.covers(suspended, host("a.b.guard-parent.example"))).toBe(true);
    expect(CoveredHosts.covers(suspended, host("open.guard-parent.example"))).toBe(false);
    expect(CoveredHosts.covers(suspended, host("notguard-parent.example"))).toBe(false);
    expect(
      await admittedInboxes(env, [
        "https://a.guard-parent.example/inbox",
        "https://open.guard-parent.example/inbox",
      ]),
    ).toEqual(["https://open.guard-parent.example/inbox"]);
  });

  it("leaves its subdomains' actors out of the known inboxes", async () => {
    await rule("known-parent.example", "suspend");
    await rule("open.known-parent.example", "noop");
    const sub = await remoteActor("known", "social.known-parent.example");
    const exempt = await remoteActor("known", "open.known-parent.example");

    const inboxes = (await listKnownRemoteInboxes(env.DB, 10_000))._unsafeUnwrap();
    expect(inboxes).not.toContain(`${sub.actorUri}/inbox`);
    expect(inboxes).toContain(`${exempt.actorUri}/inbox`);
  });

  it("leaves its subdomains' replies out of a note's replies collection", async () => {
    const parentUri = "https://example.com/users/nobody/statuses/replied";
    const sub = await remoteActor("replier", "social.reply-parent.example");
    const exempt = await remoteActor("replier", "open.reply-parent.example");
    for (const remote of [sub, exempt]) {
      expect(
        await remote.send({
          id: `${remote.actorUri}/replies/1/activity`,
          type: "Create",
          object: {
            id: `${remote.actorUri}/replies/1`,
            type: "Note",
            attributedTo: remote.actorUri,
            inReplyTo: parentUri,
            content: "<p>reply</p>",
            published: "2026-11-01T00:00:00.000Z",
            to: [PUBLIC],
          },
        }),
      ).toBe(202);
    }
    await rule("reply-parent.example", "suspend");
    await rule("open.reply-parent.example", "noop");

    const { results } = await d1PrepareTyped(
      env.DB,
      listRemoteNoteReplies(parentUri, "", 40),
    ).all();
    expect(
      z
        .array(z.object({ object_uri: z.string() }))
        .parse(results)
        .map((row) => row.object_uri),
    ).toEqual([`${exempt.actorUri}/replies/1`]);
  });
});

describe("a domain block row written by hand", () => {
  // The Worker reads a block's domain as `Hostname.ofAuthority`; SQL must read it the same way.
  it.each([
    ["with a port", "Port-Parent.Example:8443", "a.port-parent.example"],
    ["with a trailing dot", "dot-parent.example.", "a.dot-parent.example"],
  ])("covers the same hosts in the Worker and in SQL %s", async (_, domain, actorHost) => {
    await rule(domain, "suspend");
    const remote = await remoteActor("hand", actorHost);

    expect(CoveredHosts.covers(await suspendedDomains(env.DB), host(actorHost))).toBe(true);
    const { results } = await env.DB.prepare(
      "SELECT actor_uri FROM remote_actor_domain_rules WHERE actor_uri = ? AND severity = 'suspend'",
    )
      .bind(remote.actorUri)
      .all();
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("an instance reject_media of a parent domain", () => {
  it("covers its subdomains, most specific rule first", async () => {
    await rule("media-parent.example", "noop", { rejectMedia: true });
    await rule("open.media-parent.example", "noop");
    const rejected = await mediaRejectedDomains(env.DB);

    expect(CoveredHosts.covers(rejected, host("cdn.media-parent.example"))).toBe(true);
    expect(CoveredHosts.covers(rejected, host("open.media-parent.example"))).toBe(false);
  });

  it("clears the stored media of its subdomains' posts when the block is made", async () => {
    const sub = await remoteActor("media", "cdn.clear-parent.example");
    const uri = "https://cdn.clear-parent.example/notes/1";
    const id = await remoteNote(sub, uri);
    await env.DB.prepare("UPDATE remote_statuses SET media_json = ? WHERE id = ?")
      .bind('[{"kind":"placeholder"}]', id)
      .run();
    const blocked = await SELF.fetch("https://example.com/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("subdomain-media-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({
        domain: "clear-parent.example",
        severity: "noop",
        reject_media: true,
      }),
    });
    expect(blocked.status).toBe(200);

    const row = await env.DB.prepare("SELECT media_json FROM remote_statuses WHERE id = ?")
      .bind(id)
      .first();
    expect(z.object({ media_json: z.string() }).parse(row).media_json).toBe("[]");
  });
});

describe("peer search", () => {
  // `Instance.searchable` leaves out only the exact domains of `domain_blocks`.
  it("still lists a subdomain of a blocked domain, as Instance.searchable", async () => {
    await remoteActor("peer", "social.peer-parent.example");
    await rule("peer-parent.example", "suspend");

    const response = await SELF.fetch(
      "https://example.com/api/v1/peers/search?q=social.peer-parent",
    );
    expect(await response.json()).toEqual(["social.peer-parent.example"]);
  });
});
