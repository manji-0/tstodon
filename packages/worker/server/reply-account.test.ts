import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { settle } from "../test/meter";
import { holdQueue } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon v4.7.5 sets a reply's `in_reply_to_account_id` when it saves the
// reply with its parent (`Status#set_conversation`): the parent's own
// `in_reply_to_account_id` for a reply to the author's own reply, else the
// parent's author (`carried_over_reply_to_account_id`). It is not computed
// again when a status above arrives later. The REST entity, home's reply
// filter (`FeedManager#filter_from_home`) and the context's self-reply order
// (`promote_by!`) all read it.

vi.setConfig({ testTimeout: 45_000 });

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

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

const Status = z.object({
  id: z.string(),
  in_reply_to_id: z.string().nullable(),
  in_reply_to_account_id: z.string().nullable(),
});

const post = async (email: string, status: string, inReplyToId?: string): Promise<string> =>
  Status.parse(
    await call(email, "/api/v1/statuses", {
      status,
      ...(inReplyToId === undefined ? {} : { in_reply_to_id: inReplyToId }),
    }),
  ).id;

const answered = async (email: string, id: string): Promise<string | null> =>
  Status.parse(await call(email, `/api/v1/statuses/${id}`)).in_reply_to_account_id;

const homeIds = async (email: string): Promise<string[]> =>
  z
    .array(Status)
    .parse(await call(email, "/api/v1/timelines/home?limit=40"))
    .map((status) => status.id);

const descendantIds = async (email: string, id: string): Promise<string[]> =>
  z
    .object({ descendants: z.array(Status) })
    .parse(await call(email, `/api/v1/statuses/${id}/context`))
    .descendants.map((status) => status.id);

const remoteId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const followRemote = async (email: string, remote: Remote): Promise<void> => {
  await call(email, `/api/v1/accounts/${remoteId(remote)}/follow`, {});
  const viewer = await signedInAccount(email);
  const [row] = parseRows(
    z.object({ follow_activity_id: z.string() }),
    (
      await env.DB.prepare(
        "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
      )
        .bind(viewer.id, remote.actorUri)
        .all()
    ).results,
  );
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${viewer.id}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const note = (author: Remote, slug: string, inReplyTo?: string) => ({
  id: `${new URL(author.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: new Date().toISOString(),
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...(inReplyTo === undefined ? {} : { inReplyTo }),
});

/** Have `author` deliver its note `slug`, replying to `inReplyTo`; the stored id. */
const deliver = async (author: Remote, slug: string, inReplyTo?: string): Promise<string> => {
  const object = note(author, slug, inReplyTo);
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

const noteUri = (author: Remote, slug: string): string =>
  `${new URL(author.actorUri).origin}/notes/${slug}`;

const localUri = (username: string, id: string): string =>
  `https://example.com/users/${username}/statuses/${id}`;

describe("in_reply_to_account_id", () => {
  it("carries a local self-reply's parent's answer over", async () => {
    const alice = "ra-local-alice@example.com";
    const bob = await signedInAccount("ra-local-bob@example.com");
    const carol = await remoteActor("ra-local-carol", "ra-local-carol.example");
    const me = await signedInAccount(alice);
    holdQueue();

    const bobRoot = await post("ra-local-bob@example.com", "bob's thread");
    const toBob = await post(alice, "to bob", bobRoot);
    const underToBob = await post(alice, "more to bob", toBob);
    const carolNote = await deliver(carol, "carol");
    const toCarol = await post(alice, "to carol", carolNote);
    const underToCarol = await post(alice, "more to carol", toCarol);
    const own = await post(alice, "my thread");
    const second = await post(alice, "my second", own);
    const third = await post(alice, "my third", second);

    expect(await answered(alice, toBob)).toBe(bob.id);
    expect(await answered(alice, underToBob)).toBe(bob.id);
    expect(await answered(alice, toCarol)).toBe(remoteId(carol));
    expect(await answered(alice, underToCarol)).toBe(remoteId(carol));
    expect(await answered(alice, own)).toBeNull();
    expect(await answered(alice, second)).toBe(me.id);
    expect(await answered(alice, third)).toBe(me.id);
  });

  it("carries a remote self-reply's parent's answer over", async () => {
    const reader = "ra-remote-reader@example.com";
    const bob = await signedInAccount("ra-remote-bob@example.com");
    const dave = await remoteActor("ra-remote-dave", "ra-remote-dave.example");
    const erin = await remoteActor("ra-remote-erin", "ra-remote-erin.example");
    await signedInAccount(reader);
    holdQueue();

    const erinNote = noteUri(erin, "erin");
    await deliver(erin, "erin");
    const toErin = await deliver(dave, "to-erin", erinNote);
    const underToErin = await deliver(dave, "under-to-erin", noteUri(dave, "to-erin"));
    const bobRoot = await post("ra-remote-bob@example.com", "bob's thread");
    const toBob = await deliver(dave, "to-bob", localUri(bob.username, bobRoot));
    const underToBob = await deliver(dave, "under-to-bob", noteUri(dave, "to-bob"));
    await deliver(dave, "root");
    const second = await deliver(dave, "second", noteUri(dave, "root"));
    const third = await deliver(dave, "third", noteUri(dave, "second"));
    // A reply to a note not held has no account, and so has its self-reply.
    const unlinked = await deliver(dave, "unlinked", "https://ra-remote-gone.example/notes/1");
    const underUnlinked = await deliver(dave, "under-unlinked", noteUri(dave, "unlinked"));

    expect(await answered(reader, toErin)).toBe(remoteId(erin));
    expect(await answered(reader, underToErin)).toBe(remoteId(erin));
    expect(await answered(reader, toBob)).toBe(bob.id);
    expect(await answered(reader, underToBob)).toBe(bob.id);
    expect(await answered(reader, second)).toBe(remoteId(dave));
    expect(await answered(reader, third)).toBe(remoteId(dave));
    expect(await answered(reader, unlinked)).toBeNull();
    expect(await answered(reader, underUnlinked)).toBeNull();
  });

  it("is set when a reply is linked, and not again when a status above it arrives", async () => {
    const reader = "ra-late-reader@example.com";
    const frank = await remoteActor("ra-late-frank", "ra-late-frank.example");
    const gina = await remoteActor("ra-late-gina", "ra-late-gina.example");
    await signedInAccount(reader);
    holdQueue();

    const answer = await deliver(frank, "answer", noteUri(gina, "root"));
    const underAnswer = await deliver(frank, "under-answer", noteUri(frank, "answer"));
    const lateAnswer = noteUri(frank, "late-answer");
    const underLate = await deliver(frank, "under-late", lateAnswer);
    await deliver(gina, "root");
    await deliver(frank, "late-answer", noteUri(gina, "root"));

    // Linked when Gina's root arrived.
    expect(await answered(reader, answer)).toBe(remoteId(gina));
    // Linked to Frank's answer while that had no account: Mastodon keeps nil.
    expect(await answered(reader, underAnswer)).toBeNull();
    // Linked when its parent arrived, already answering Gina.
    expect(await answered(reader, underLate)).toBe(remoteId(gina));
  });
});

describe("home's reply filter", () => {
  it("drops a self-reply under a reply to an account the reader does not follow", async () => {
    const reader = "ra-home-reader@example.com";
    const alice = "ra-home-alice@example.com";
    const bob = "ra-home-bob@example.com";
    const aliceAccount = await signedInAccount(alice);
    await signedInAccount(bob);
    const dave = await remoteActor("ra-home-dave", "ra-home-dave.example");
    const erin = await remoteActor("ra-home-erin", "ra-home-erin.example");
    await call(reader, `/api/v1/accounts/${aliceAccount.id}/follow`, {});
    await followRemote(reader, dave);
    holdQueue();

    const bobRoot = await post(bob, "bob's thread");
    const toBob = await post(alice, "to bob", bobRoot);
    const underToBob = await post(alice, "more to bob", toBob);
    const own = await post(alice, "my thread");
    const second = await post(alice, "my second", own);
    const underSecond = await post(alice, "my third", second);
    await deliver(erin, "erin");
    const toErin = await deliver(dave, "to-erin", noteUri(erin, "erin"));
    const underToErin = await deliver(dave, "under-to-erin", noteUri(dave, "to-erin"));
    const daveRoot = await deliver(dave, "root");
    const daveSecond = await deliver(dave, "second", noteUri(dave, "root"));
    const daveThird = await deliver(dave, "third", noteUri(dave, "second"));

    const home = await homeIds(reader);

    expect(home).toEqual(
      expect.arrayContaining([own, second, underSecond, daveRoot, daveSecond, daveThird]),
    );
    expect(home).not.toContain(toBob);
    expect(home).not.toContain(underToBob);
    expect(home).not.toContain(toErin);
    expect(home).not.toContain(underToErin);
  });
});

describe("the context's self-reply order", () => {
  it("moves up only the replies that answer their own author", async () => {
    const lee = "ra-context-lee@example.com";
    const mia = "ra-context-mia@example.com";
    await signedInAccount(lee);
    await signedInAccount(mia);

    const root = await post(lee, "lee's thread");
    const fromMia = await post(mia, "mia answers", root);
    const toMia = await post(lee, "lee answers mia", fromMia);
    const underToMia = await post(lee, "lee goes on to mia", toMia);
    const own = await post(lee, "lee goes on", root);

    // Mastodon's `promote_by!` reads `in_reply_to_account_id == account_id`:
    // Lee's reply under his answer to Mia answers Mia.
    expect(await descendantIds(lee, root)).toEqual([own, fromMia, toMia, underToMia]);
  });
});
