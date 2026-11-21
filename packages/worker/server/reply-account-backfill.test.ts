import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import migration from "../app/db/migrations/0162_status_reply_accounts.sql?raw";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { settle } from "../test/meter";
import { holdQueue } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Migration 0162 fills in whom each stored reply answers: what Mastodon's
// `carried_over_reply_to_account_id` gives with the statuses as they are.

vi.setConfig({ testTimeout: 45_000 });

afterEach(() => {
  vi.restoreAllMocks();
});

const call = async (email: string, path: string, body?: object): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

const Status = z.object({ id: z.string(), in_reply_to_account_id: z.string().nullable() });

const post = async (email: string, status: string, inReplyToId?: string): Promise<string> =>
  Status.parse(
    await call(email, "/api/v1/statuses", {
      status,
      ...(inReplyToId === undefined ? {} : { in_reply_to_id: inReplyToId }),
    }),
  ).id;

const answered = async (email: string, id: string): Promise<string | null> =>
  Status.parse(await call(email, `/api/v1/statuses/${id}`)).in_reply_to_account_id;

const noteUri = (author: Remote, slug: string): string =>
  `${new URL(author.actorUri).origin}/notes/${slug}`;

const deliver = async (author: Remote, slug: string, inReplyTo?: string): Promise<string> => {
  const object = {
    id: noteUri(author, slug),
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: new Date().toISOString(),
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  };
  expect(await author.send({ id: `${object.id}/create`, type: "Create", object })).toBe(202);
  await settle();
  const [row] = parseRows(
    z.object({ id: z.string() }),
    (
      await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
        .bind(object.id)
        .all()
    ).results,
  );
  if (row === undefined) {
    throw new Error(`${object.id} was not stored`);
  }
  return row.id;
};

/** Forget every stored reply account, then run the migration's backfill. */
const backfill = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE statuses SET in_reply_to_account_id = NULL, in_reply_to_actor_uri = NULL",
    ),
    env.DB.prepare(
      "UPDATE remote_statuses SET in_reply_to_account_id = NULL, in_reply_to_actor_uri = NULL",
    ),
  ]);
  const statements = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*\n(?=\S|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("WITH RECURSIVE"));
  expect(statements).toHaveLength(2);
  for (const statement of statements) {
    await env.DB.prepare(statement.replace(/;$/, "")).run();
  }
};

describe("migration 0162", () => {
  it("fills in whom the replies stored before it answer", async () => {
    const alice = "rab-alice@example.com";
    const bob = await signedInAccount("rab-bob@example.com");
    const me = await signedInAccount(alice);
    const dave = await remoteActor("rab-dave", "rab-dave.example");
    const erin = await remoteActor("rab-erin", "rab-erin.example");
    holdQueue();

    const bobRoot = await post("rab-bob@example.com", "bob's thread");
    const toBob = await post(alice, "to bob", bobRoot);
    const underToBob = await post(alice, "more to bob", toBob);
    const own = await post(alice, "my thread");
    const second = await post(alice, "my second", own);
    const third = await post(alice, "my third", second);
    await deliver(erin, "erin");
    const toErin = await post(alice, "to erin", await deliver(erin, "erin-2"));
    const underToErin = await post(alice, "more to erin", toErin);
    const daveToErin = await deliver(dave, "to-erin", noteUri(erin, "erin"));
    const daveUnder = await deliver(dave, "under", noteUri(dave, "to-erin"));
    const daveToBob = await deliver(
      dave,
      "to-bob",
      `https://example.com/users/${bob.username}/statuses/${bobRoot}`,
    );
    const daveUnderBob = await deliver(dave, "under-bob", noteUri(dave, "to-bob"));
    await deliver(dave, "root");
    const daveSecond = await deliver(dave, "second", noteUri(dave, "root"));
    const daveThird = await deliver(dave, "third", noteUri(dave, "second"));
    const daveUnlinked = await deliver(dave, "unlinked", "https://rab-gone.example/notes/1");
    const daveUnderUnlinked = await deliver(dave, "under-unlinked", noteUri(dave, "unlinked"));

    await backfill();

    const expected: ReadonlyArray<readonly [string, string | null]> = [
      [bobRoot, null],
      [toBob, bob.id],
      [underToBob, bob.id],
      [own, null],
      [second, me.id],
      [third, me.id],
      [toErin, RemoteAccountId.encode(erin.actorUri)],
      [underToErin, RemoteAccountId.encode(erin.actorUri)],
      [daveToErin, RemoteAccountId.encode(erin.actorUri)],
      [daveUnder, RemoteAccountId.encode(erin.actorUri)],
      [daveToBob, bob.id],
      [daveUnderBob, bob.id],
      [daveSecond, RemoteAccountId.encode(dave.actorUri)],
      [daveThird, RemoteAccountId.encode(dave.actorUri)],
      [daveUnlinked, null],
      [daveUnderUnlinked, null],
    ];
    const actual = await Promise.all(
      expected.map(async ([id]) => [id, await answered(alice, id)] as const),
    );
    expect(actual).toEqual(expected);
  });
});
