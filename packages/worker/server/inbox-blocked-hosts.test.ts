import { SELF, env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

/**
 * An actor on a domain this instance federates with sends activities that
 * name objects on an admin-suspended domain. Handling them must not reach
 * that domain, as the inbox already guarantees for `Announce` and `Move`.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const BLOCKED = "inbox-guard-blocked.example";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

/**
 * The URLs the worker fetched. The stub serves a note or actor document for
 * any URL on the suspended domain, so a fetch that got through would import it.
 */
const stubFetch = (): string[] => {
  const fetched: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new Request(input, init).url;
    fetched.push(url);
    if (new URL(url).hostname !== BLOCKED) {
      return new Response(null, { status: 404 });
    }
    const actorUri = `https://${BLOCKED}/users/mallory`;
    if (url === actorUri) {
      return Response.json({
        id: actorUri,
        type: "Person",
        preferredUsername: "mallory",
        inbox: `${actorUri}/inbox`,
        alsoKnownAs: [],
        publicKey: { id: `${actorUri}#main-key`, owner: actorUri, publicKeyPem: "unused" },
      });
    }
    return Response.json({
      id: url,
      type: "Note",
      attributedTo: actorUri,
      content: "<p>from a suspended domain</p>",
      published: "2026-11-01T00:00:00.000Z",
      to: [PUBLIC],
    });
  });
  return fetched;
};

const toBlocked = (fetched: readonly string[]): string[] =>
  fetched.filter((url) => new URL(url).hostname === BLOCKED);

const CountSchema = z.object({ count: z.number() });

/** How many rows of `table` name the suspended domain in `column`. */
const storedFromBlocked = async (table: string, column: string): Promise<number> =>
  read(
    CountSchema,
    await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`)
      .bind(`https://${BLOCKED}/%`)
      .first(),
  ).count;

const expectNothingFromBlocked = async (fetched: readonly string[]): Promise<void> => {
  expect(toBlocked(fetched)).toEqual([]);
  expect(await storedFromBlocked("remote_statuses", "object_uri")).toBe(0);
  expect(await storedFromBlocked("remote_actors", "actor_uri")).toBe(0);
};

const note = (author: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: "2026-11-01T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...extra,
});

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT INTO domain_blocks (id, domain, severity) VALUES ('inbox-guard-block', ?, 'suspend')",
  )
    .bind(BLOCKED)
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inbox activities naming objects on a suspended domain", () => {
  it("stores a Create's note without fetching the note it quotes or replies to there", async () => {
    const bob = await remoteActor("guard-create-bob");
    const fetched = stubFetch();
    const object = note(bob, "guard-create", {
      quote: `https://${BLOCKED}/notes/quoted`,
      quoteAuthorization: `https://${BLOCKED}/users/mallory/stamps/quoted`,
      inReplyTo: `https://${BLOCKED}/notes/parent`,
    });

    expect(await bob.send({ id: `${object.id}#create`, type: "Create", object })).toBe(202);

    // The note itself, from an allowed domain, is stored.
    const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(object.id)
      .first();
    expect(row).not.toBeNull();
    await expectNothingFromBlocked(fetched);
  });

  it("does not fetch an Update's object named by a URI there", async () => {
    const bob = await remoteActor("guard-update-bob");
    const fetched = stubFetch();

    expect(
      await bob.send({
        id: "https://remote.example/activities/guard-update-uri",
        type: "Update",
        object: `https://${BLOCKED}/notes/updated`,
      }),
    ).toBe(202);

    await expectNothingFromBlocked(fetched);
  });

  it("does not fetch a note an edit newly quotes there", async () => {
    const bob = await remoteActor("guard-edit-bob");
    const object = note(bob, "guard-edit");
    expect(await bob.send({ id: `${object.id}#create`, type: "Create", object })).toBe(202);
    const fetched = stubFetch();

    expect(
      await bob.send({
        id: "https://remote.example/activities/guard-edit-update",
        type: "Update",
        object: {
          ...object,
          content: "<p>now quoting</p>",
          updated: "2026-11-02T00:00:00.000Z",
          quote: `https://${BLOCKED}/notes/edit-quoted`,
        },
      }),
    ).toBe(202);

    await expectNothingFromBlocked(fetched);
  });

  it("does not fetch the actor an Update's movedTo names there", async () => {
    const bob = await remoteActor("guard-moved-bob");
    const fetched = stubFetch();

    expect(
      await bob.send({
        id: "https://remote.example/activities/guard-moved-update",
        type: "Update",
        object: {
          id: bob.actorUri,
          type: "Person",
          preferredUsername: "guard-moved-bob",
          inbox: `${bob.actorUri}/inbox`,
          name: "Moved Bob",
          movedTo: `https://${BLOCKED}/users/mallory`,
          publicKey: {
            id: `${bob.actorUri}#main-key`,
            owner: bob.actorUri,
            publicKeyPem: bob.publicKeyPem,
          },
        },
      }),
    ).toBe(202);

    await expectNothingFromBlocked(fetched);
  });

  it("does not fetch a QuoteRequest's instrument named by a URI there", async () => {
    const email = "guard-quote-request-alice@example.com";
    const alice = await signedInAccount(email);
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ status: "quote me" }),
    });
    expect(posted.status).toBe(200);
    const statusId = read(z.object({ id: z.string() }), await posted.json()).id;
    const bob = await remoteActor("guard-quote-request-bob");
    const fetched = stubFetch();

    expect(
      await bob.send({
        id: `${bob.actorUri}/quote_requests/guard`,
        type: "QuoteRequest",
        object: `https://example.com/users/${alice.username}/statuses/${statusId}`,
        instrument: `https://${BLOCKED}/notes/instrument`,
      }),
    ).toBe(202);

    await expectNothingFromBlocked(fetched);
  });
});
