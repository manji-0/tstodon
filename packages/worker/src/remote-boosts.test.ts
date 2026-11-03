import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const EntrySchema = z.object({
  id: z.string(),
  uri: z.string(),
  account: z.object({ id: z.string() }),
  reblog: z
    .object({ id: z.string(), uri: z.string(), account: z.object({ id: z.string() }) })
    .nullable(),
});

type Entry = z.infer<typeof EntrySchema>;

const home = async (email: string, query = ""): Promise<Entry[]> =>
  read(
    z.array(EntrySchema),
    (await json(`/api/v1/timelines/home${query}`, { headers: await authHeaders(email) })).body,
  );

/** Each home entry as the URI a reader sees: the boosted status's for a boost. */
const homeUris = async (email: string, query = ""): Promise<string[]> =>
  (await home(email, query)).map((entry) => entry.reblog?.uri ?? entry.uri);

const accountId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const acceptedFollow = async (
  email: string,
  remote: Remote,
  slug: string,
  options: Record<string, unknown> = {},
) => {
  const followed = await json(`/api/v1/accounts/${accountId(remote)}/follow`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: JSON.stringify(options),
  });
  expect(followed.status).toBe(200);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

/** A public note by `author`, delivered to (and cached by) this instance. */
const note = async (author: Remote, slug: string): Promise<string> => {
  const noteUri = `${new URL(author.actorUri).origin}/notes/${slug}`;
  expect(
    await author.send({
      id: `${noteUri}/activity`,
      type: "Create",
      object: noteDocument(author, noteUri, slug),
    }),
  ).toBe(202);
  return noteUri;
};

const noteDocument = (author: Remote, noteUri: string, slug: string) => ({
  id: noteUri,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
});

const announceId = (booster: Remote, slug: string) =>
  `${booster.actorUri}/statuses/${slug}/activity`;

const boost = async (booster: Remote, objectUri: string, slug: string): Promise<number> =>
  booster.send({
    id: announceId(booster, slug),
    type: "Announce",
    object: objectUri,
    published: "2026-10-21T00:00:00.000Z",
    to: [PUBLIC],
    cc: [`${booster.actorUri}/followers`],
  });

const localPost = async (email: string, status: string) =>
  read(
    z.object({ id: z.string(), uri: z.string() }),
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: JSON.stringify({ status }),
      })
    ).body,
  );

describe("remote boosts on the home timeline", () => {
  it("shows a followed actor's boost of a cached remote note, to its follower only", async () => {
    const booster = await remoteActor("boost-cached-booster", "booster.example");
    const author = await remoteActor("boost-cached-author");
    const follower = "boost-cached-follower@example.com";
    const other = "boost-cached-other@example.com";
    await signedInAccount(other);
    await acceptedFollow(follower, booster, "cached");
    const noteUri = await note(author, "boost-cached");
    expect(await homeUris(follower)).toEqual([]);

    expect(await boost(booster, noteUri, "cached")).toBe(202);

    const [entry] = await home(follower);
    expect(entry).toMatchObject({
      uri: announceId(booster, "cached"),
      account: { id: accountId(booster) },
      reblog: { uri: noteUri, account: { id: accountId(author) } },
    });
    expect(entry?.id).not.toBe(entry?.reblog?.id);
    expect(await home(other)).toEqual([]);
  });

  it("fetches another actor's note the boost names and stores it under its author", async () => {
    const booster = await remoteActor("boost-fetch-booster", "booster.example");
    const author = await remoteActor("boost-fetch-author");
    const follower = "boost-fetch-follower@example.com";
    await acceptedFollow(follower, booster, "fetch");
    const noteUri = "https://remote.example/notes/boost-fetched";

    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return href === noteUri
        ? new Response(JSON.stringify(noteDocument(author, noteUri, "boost-fetched")), {
            headers: { "content-type": "application/activity+json" },
          })
        : original(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      expect(await boost(booster, noteUri, "fetch")).toBe(202);
    } finally {
      globalThis.fetch = original;
    }

    expect(await home(follower)).toMatchObject([
      {
        account: { id: accountId(booster) },
        reblog: { uri: noteUri, account: { id: accountId(author) } },
      },
    ]);
  });

  it("shows a boost of a local note and still notifies its author", async () => {
    const booster = await remoteActor("boost-local-booster", "booster.example");
    const author = "boost-local-author@example.com";
    const follower = "boost-local-follower@example.com";
    await acceptedFollow(follower, booster, "local");
    const status = await localPost(author, "a local note to boost");

    expect(await boost(booster, status.uri, "local")).toBe(202);

    expect(await home(follower)).toMatchObject([
      { account: { id: accountId(booster) }, reblog: { id: status.id, uri: status.uri } },
    ]);
    const notifications = read(
      z.array(z.object({ type: z.string(), account: z.object({ id: z.string() }) })),
      (await json("/api/v1/notifications", { headers: await authHeaders(author) })).body,
    );
    expect(notifications).toMatchObject([{ type: "reblog", account: { id: accountId(booster) } }]);
  });

  it("keeps boosts out for a follow with reblogs off", async () => {
    const booster = await remoteActor("boost-off-booster", "booster.example");
    const author = await remoteActor("boost-off-author");
    const follower = "boost-off-follower@example.com";
    await acceptedFollow(follower, booster, "off", { reblogs: false });
    const noteUri = await note(author, "boost-off");

    expect(await boost(booster, noteUri, "off")).toBe(202);

    expect(await home(follower)).toEqual([]);
  });

  it("removes the boost on Undo, and keeps one entry per redelivered or repeated Announce", async () => {
    const booster = await remoteActor("boost-undo-booster", "booster.example");
    const author = await remoteActor("boost-undo-author");
    const follower = "boost-undo-follower@example.com";
    await acceptedFollow(follower, booster, "undo");
    const noteUri = await note(author, "boost-undo");

    expect(await boost(booster, noteUri, "undo")).toBe(202);
    expect(await boost(booster, noteUri, "undo")).toBe(202);
    expect(await boost(booster, noteUri, "undo-again")).toBe(202);
    expect(await homeUris(follower)).toEqual([noteUri]);

    const impostor = await remoteActor("boost-undo-impostor", "booster.example");
    const undo = (actor: Remote, slug: string) =>
      actor.send({
        id: `${actor.actorUri}/undos/${slug}`,
        type: "Undo",
        object: {
          id: announceId(booster, "undo"),
          type: "Announce",
          actor: booster.actorUri,
          object: noteUri,
        },
      });
    expect(await undo(impostor, "impostor")).toBe(202);
    expect(await homeUris(follower)).toEqual([noteUri]);

    expect(await undo(booster, "booster")).toBe(202);
    expect(await homeUris(follower)).toEqual([]);
  });

  it("hides a boost of an author the viewer mutes", async () => {
    const booster = await remoteActor("boost-mute-booster", "booster.example");
    const author = await remoteActor("boost-mute-author");
    const follower = "boost-mute-follower@example.com";
    await acceptedFollow(follower, booster, "mute");
    expect(await boost(booster, await note(author, "boost-mute"), "mute")).toBe(202);
    expect(await home(follower)).toHaveLength(1);

    const muted = await json(`/api/v1/accounts/${accountId(author)}/mute`, {
      method: "POST",
      headers: await authHeaders(follower),
    });
    expect(muted.status).toBe(200);
    expect(await home(follower)).toEqual([]);
  });

  it("pages local statuses, remote statuses, and boosts with one id cursor", async () => {
    const booster = await remoteActor("boost-page-booster", "booster.example");
    const author = await remoteActor("boost-page-author");
    const follower = "boost-page-follower@example.com";
    await acceptedFollow(follower, booster, "page");
    const own = await localPost(follower, "my own post");
    const boosterNote = await note(booster, "boost-page-own");
    expect(await boost(booster, await note(author, "boost-page-boosted"), "page")).toBe(202);

    const entries = await home(follower);
    expect(entries.map((entry) => entry.uri)).toEqual([
      announceId(booster, "page"),
      boosterNote,
      own.uri,
    ]);
    const pages: string[] = [];
    let maxId = "";
    for (let page = 0; page < 4; page += 1) {
      const [entry] = await home(follower, `?limit=1${maxId ? `&max_id=${maxId}` : ""}`);
      if (!entry) {
        break;
      }
      pages.push(entry.uri);
      maxId = entry.id;
    }
    expect(pages).toEqual(entries.map((entry) => entry.uri));
    expect(
      (await home(follower, `?min_id=${entries[2]?.id ?? ""}`)).map((entry) => entry.uri),
    ).toEqual([boosterNote, announceId(booster, "page")]);
  });

  it("drops the boosts of a deleted actor and of a deleted note", async () => {
    const booster = await remoteActor("boost-gone-booster", "booster.example");
    const author = await remoteActor("boost-gone-author");
    const follower = "boost-gone-follower@example.com";
    await acceptedFollow(follower, booster, "gone");
    const other = await remoteActor("boost-gone-other", "booster.example");
    await acceptedFollow(follower, other, "gone-other");
    const noteUri = await note(author, "boost-gone");
    expect(await boost(booster, noteUri, "gone")).toBe(202);
    expect(await boost(other, noteUri, "gone-other")).toBe(202);
    const boosted = await home(follower);
    expect(boosted).toHaveLength(2);

    expect(
      await booster.send({
        id: `${booster.actorUri}#delete`,
        type: "Delete",
        object: booster.actorUri,
      }),
    ).toBe(202);
    expect((await home(follower)).map((entry) => entry.account.id)).toEqual([accountId(other)]);

    expect(
      await author.send({
        id: `${noteUri}#delete`,
        type: "Delete",
        object: { id: noteUri, type: "Tombstone" },
      }),
    ).toBe(202);
    expect(await home(follower)).toEqual([]);
  });
});
