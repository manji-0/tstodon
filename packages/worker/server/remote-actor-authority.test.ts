import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { deliveredCreate } from "../test/delivery-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import migration from "../app/db/migrations/0097_remote_actor_authority.sql?raw";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const call = (path: string, init?: RequestInit) => SELF.fetch(`https://example.com${path}`, init);

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const AccountSchema = z.object({ id: z.string(), acct: z.string() });

const publicNote = async (author: Remote, slug: string): Promise<string> => {
  const object = {
    id: `${new URL(author.actorUri).origin}/notes/${slug}`,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-10-20T00:00:00.000Z",
    to: [PUBLIC],
  };
  expect(await author.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);
  return object.id;
};

const profileUris = async (actorUri: string): Promise<string[]> =>
  read(
    z.array(z.object({ uri: z.string() })),
    await (await call(`/api/v1/accounts/${RemoteAccountId.encode(actorUri)}/statuses`)).json(),
  ).map((status) => status.uri);

const publicUris = async (email: string): Promise<string[]> =>
  read(
    z.array(z.object({ uri: z.string() })),
    await (
      await call("/api/v1/timelines/public?limit=40", { headers: await authHeaders(email) })
    ).json(),
  ).map((status) => status.uri);

describe("a remote actor on a non-default port", () => {
  it("keeps its port in the handle, apart from the same name on another port", async () => {
    const first = await remoteActor("ported-bob", "127.0.0.1:8792");
    const second = await remoteActor("ported-bob", "127.0.0.1:8793");

    const firstId = RemoteAccountId.encode(first.actorUri);
    const secondId = RemoteAccountId.encode(second.actorUri);
    expect(read(AccountSchema, await (await call(`/api/v1/accounts/${firstId}`)).json()).acct).toBe(
      "ported-bob@127.0.0.1:8792",
    );
    for (const [actor, id] of [
      [first, firstId],
      [second, secondId],
    ] as const) {
      const handle = `ported-bob@${new URL(actor.actorUri).host}`;
      const found = read(
        z.array(AccountSchema),
        await (
          await call(`/api/v1/accounts/search?q=${encodeURIComponent(`@${handle}`)}&limit=5`, {
            headers: await authHeaders("authority-searcher@example.com"),
          })
        ).json(),
      )[0];
      expect(found).toEqual({ id, acct: handle });
    }
  });

  it("is covered by a user's and the admin's block on its bare hostname", async () => {
    const email = "authority-viewer@example.com";
    const actor = await remoteActor("blocked-bob", "blocked-peer.test:8795");
    const noteUri = await publicNote(actor, "authority-note");
    expect(await profileUris(actor.actorUri)).toEqual([noteUri]);
    expect(await publicUris(email)).toContain(noteUri);

    const userBlock = await call("/api/v1/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ domain: "blocked-peer.test:8795" }),
    });
    expect(userBlock.status).toBe(200);
    const stored = await env.DB.prepare(
      "SELECT domain FROM account_domain_blocks WHERE domain LIKE 'blocked-peer.test%'",
    ).all<{ domain: string }>();
    expect(stored.results.map((row) => row.domain)).toEqual(["blocked-peer.test"]);
    expect(await publicUris(email)).not.toContain(noteUri);
    expect(await profileUris(actor.actorUri)).toEqual([noteUri]);

    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('authority-block', 'blocked-peer.test', 'suspend')",
    ).run();
    expect(await profileUris(actor.actorUri)).toEqual([]);
    expect(
      await actor.send({
        id: "https://blocked-peer.test:8795/activities/after-suspend",
        type: "Create",
        object: {
          id: "https://blocked-peer.test:8795/notes/after-suspend",
          type: "Note",
          attributedTo: actor.actorUri,
          content: "<p>after</p>",
          published: "2026-10-21T00:00:00.000Z",
          to: [PUBLIC],
        },
      }),
    ).toBe(403);
  });

  it("gets no fan-out from a note once its bare hostname is suspended", async () => {
    const email = "authority-fanout@example.com";
    const author = read(
      z.object({ id: z.string() }),
      await (
        await call("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })
      ).json(),
    );
    const ported = await remoteActor("fanout-bob", "fanout-peer.test:8797");
    const other = await remoteActor("fanout-carol", "fanout-other.test");
    for (const follower of [ported, other]) {
      await env.DB.prepare(
        `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
         VALUES (?, ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
      )
        .bind(`fanout-${follower.actorUri}`, follower.actorUri, author.id)
        .run();
    }
    // Inserted directly: the admin path would sever the follow before any fan-out.
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('fanout-block', 'fanout-peer.test', 'suspend')",
    ).run();

    const note = read(
      z.object({ uri: z.string() }),
      await (
        await call("/api/v1/statuses", {
          method: "POST",
          headers: { "content-type": "application/json", ...(await authHeaders(email)) },
          body: JSON.stringify({ status: "to every follower", visibility: "public" }),
        })
      ).json(),
    );
    const delivered = await deliveredCreate(author.id, note.uri);
    expect(delivered?.inboxes).toEqual([`${other.actorUri}/inbox`]);
    // The post's queued fan-out to followers is still running: let it start
    // its delivery Workflows before the file ends, as a teardown during that
    // never completes.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });
});

describe("the authority migration", () => {
  it("restores the port to rows cached without it and strips it from blocks", async () => {
    const actor = await remoteActor("legacy-bob", "legacy-peer.test:8796");
    await env.DB.prepare("UPDATE remote_actors SET domain = 'legacy-peer.test' WHERE actor_uri = ?")
      .bind(actor.actorUri)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO domain_blocks (id, domain, severity) VALUES ('legacy-ported', 'legacy-peer.test:8796', 'silence')",
      ),
      env.DB.prepare(
        "INSERT INTO domain_blocks (id, domain, severity) VALUES ('legacy-bare', 'legacy-both.test', 'suspend')",
      ),
      env.DB.prepare(
        "INSERT INTO domain_blocks (id, domain, severity) VALUES ('legacy-dup', 'legacy-both.test:8000', 'silence')",
      ),
    ]);

    const statements = migration
      .split(/;\s*$/m)
      .map((statement) =>
        statement
          .split("\n")
          .filter((line) => !line.startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((statement) => statement.length > 0);
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }

    const row = await env.DB.prepare("SELECT domain, host FROM remote_actors WHERE actor_uri = ?")
      .bind(actor.actorUri)
      .first();
    expect(row).toEqual({ domain: "legacy-peer.test:8796", host: "legacy-peer.test" });
    const blocks = await env.DB.prepare(
      "SELECT domain, severity FROM domain_blocks WHERE domain LIKE 'legacy-%' ORDER BY domain",
    ).all();
    expect(blocks.results).toEqual([
      { domain: "legacy-both.test", severity: "suspend" },
      { domain: "legacy-peer.test", severity: "silence" },
    ]);
  });
});
