import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { settle } from "../test/meter";
import { holdQueue } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon v4.7.5's `Status.without_replies` keeps a status that is no reply
// and a reply whose `in_reply_to_account_id` is its own author. The public
// and local timelines (`PublicFeed#without_replies_scope`), their streams
// (`FanOutOnWriteService#broadcast_to_public_streams!`) and an account's
// statuses under `exclude_replies` (`AccountStatusesFilter#no_replies_scope`)
// apply it.

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

const Status = z.object({ id: z.string() });

const post = async (email: string, status: string, inReplyToId?: string): Promise<string> =>
  Status.parse(
    await call(email, "/api/v1/statuses", {
      status,
      ...(inReplyToId === undefined ? {} : { in_reply_to_id: inReplyToId }),
    }),
  ).id;

const ids = async (email: string, path: string): Promise<string[]> =>
  z
    .array(Status)
    .parse(await call(email, path))
    .map((status) => status.id);

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

/** Alice's statuses: which of them answer her and which answer someone else. */
const localThreads = async (prefix: string) => {
  const alice = `${prefix}-alice@example.com`;
  const bob = `${prefix}-bob@example.com`;
  const aliceAccount = await signedInAccount(alice);
  const carol = await remoteActor(`${prefix}-carol`, `${prefix}-carol.example`);
  holdQueue();

  const own = await post(alice, "my thread");
  const second = await post(alice, "my second", own);
  const third = await post(alice, "my third", second);
  const bobRoot = await post(bob, "bob's thread");
  const toBob = await post(alice, "to bob", bobRoot);
  const underToBob = await post(alice, "more to bob", toBob);
  const carolNote = await deliver(carol, "carol");
  const toCarol = await post(alice, "to carol", carolNote);
  return {
    alice,
    aliceAccount,
    kept: [own, second, third],
    dropped: [toBob, underToBob, toCarol],
  };
};

/** Dave's notes: which of them answer him and which answer someone else. */
const remoteThreads = async (prefix: string) => {
  const bob = `${prefix}-bob@example.com`;
  const bobAccount = await signedInAccount(bob);
  const dave = await remoteActor(`${prefix}-dave`, `${prefix}-dave.example`);
  const erin = await remoteActor(`${prefix}-erin`, `${prefix}-erin.example`);
  holdQueue();

  const root = await deliver(dave, "root");
  const second = await deliver(dave, "second", noteUri(dave, "root"));
  const third = await deliver(dave, "third", noteUri(dave, "second"));
  await deliver(erin, "erin");
  const toErin = await deliver(dave, "to-erin", noteUri(erin, "erin"));
  const underToErin = await deliver(dave, "under-to-erin", noteUri(dave, "to-erin"));
  const bobRoot = await post(bob, "bob's thread");
  const toBob = await deliver(dave, "to-bob", localUri(bobAccount.username, bobRoot));
  // A reply to a note not held answers no one, and is a reply all the same.
  const unlinked = await deliver(dave, "unlinked", `https://${prefix}-gone.example/notes/1`);
  return {
    dave,
    kept: [root, second, third],
    dropped: [toErin, underToErin, toBob, unlinked],
  };
};

describe("the public timelines", () => {
  it("keep a local reply only when it answers its own author", async () => {
    const reader = "wr-local-reader@example.com";
    await signedInAccount(reader);
    const { kept, dropped } = await localThreads("wr-local");

    for (const path of [
      "/api/v1/timelines/public?limit=40",
      "/api/v1/timelines/public?local=true&limit=40",
    ]) {
      const timeline = await ids(reader, path);
      expect(timeline, path).toEqual(expect.arrayContaining(kept));
      for (const id of dropped) {
        expect(timeline, path).not.toContain(id);
      }
    }
  });

  it("keep a remote reply only when it answers its own author", async () => {
    const reader = "wr-remote-reader@example.com";
    await signedInAccount(reader);
    const { kept, dropped } = await remoteThreads("wr-remote");

    for (const path of [
      "/api/v1/timelines/public?limit=40",
      "/api/v1/timelines/public?remote=true&limit=40",
    ]) {
      const timeline = await ids(reader, path);
      expect(timeline, path).toEqual(expect.arrayContaining(kept));
      for (const id of dropped) {
        expect(timeline, path).not.toContain(id);
      }
    }
  });
});

describe("the public streams", () => {
  it("carry a local reply only when it answers its own author", async () => {
    const alice = "wr-stream-alice@example.com";
    const bob = "wr-stream-bob@example.com";
    await signedInAccount(alice);
    const bobRoot = await post(bob, "bob's thread");
    const own = await post(alice, "my thread");
    const stream = await openStream({
      email: "wr-stream-reader@example.com",
      query: "?stream=public:local",
    });

    await post(alice, "to bob", bobRoot);
    const second = await post(alice, "my second", own);

    const heard = await stream.next();
    expect(heard).toMatchObject({ stream: ["public:local"], event: "update" });
    expect(Status.parse(JSON.parse(heard.payload)).id).toBe(second);
    stream.close();
  });
});

describe("exclude_replies", () => {
  it("keeps a local account's replies to itself", async () => {
    const { alice, aliceAccount, kept } = await localThreads("wr-account");

    const statuses = await ids(
      alice,
      `/api/v1/accounts/${aliceAccount.id}/statuses?exclude_replies=true&limit=40`,
    );

    expect(statuses.toSorted()).toEqual(kept.toSorted());
  });

  it("keeps a remote actor's replies to itself", async () => {
    const reader = "wr-actor-reader@example.com";
    await signedInAccount(reader);
    const { dave, kept } = await remoteThreads("wr-actor");

    const statuses = await ids(
      reader,
      `/api/v1/accounts/${RemoteAccountId.encode(dave.actorUri)}/statuses?exclude_replies=true&limit=40`,
    );

    expect(statuses.toSorted()).toEqual(kept.toSorted());
  });
});
