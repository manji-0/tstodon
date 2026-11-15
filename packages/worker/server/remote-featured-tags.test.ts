import { SELF, env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { ApiFeaturedTag } from "@tstodon/api";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const featuredTags = async (accountId: string) => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${accountId}/featured_tags`,
    { headers: await authHeaders("featured-tags-viewer@example.com") },
  );
  return { status: response.status, body: await response.json() };
};

const featuredOf = async (remote: Remote) => {
  const response = await featuredTags(RemoteAccountId.encode(remote.actorUri));
  expect(response.status).toBe(200);
  return expectContract(z.array(ApiFeaturedTag), response.body);
};

const hashtag = (remote: Remote, name: string) => ({
  type: "Hashtag",
  href: `${new URL(remote.actorUri).origin}/tags/${name.toLowerCase()}`,
  name: `#${name}`,
});

/** An `Add` or `Remove` of a featured hashtag as Mastodon sends it: no `id`, to the `featured` collection. */
const tagActivity = (remote: Remote, type: "Add" | "Remove", name: string) => ({
  type,
  target: `${remote.actorUri}/collections/featured`,
  object: hashtag(remote, name),
});

/** Send at `secondsAgo`: an activity without an id is named after when it was signed. */
const sendAt = async (
  remote: Remote,
  activity: Record<string, unknown>,
  secondsAgo: number,
): Promise<number> =>
  (await SELF.fetch(await remote.delivery(activity, new Date(Date.now() - secondsAgo * 1000))))
    .status;

/** Run `body` while `fetch` serves `documents` by URL and 404s anything else. */
const serving = async <T>(
  documents: ReadonlyMap<string, unknown>,
  body: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents.get(href);
    return document === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
};

/** The actor document with a `featuredTags` collection that holds `items`. */
const featuredTagsDocuments = (
  remote: Remote,
  items: ReadonlyArray<unknown>,
): ReadonlyMap<string, unknown> => {
  const collection = `${remote.actorUri}/collections/tags`;
  return new Map<string, unknown>([
    [
      remote.actorUri,
      {
        id: remote.actorUri,
        type: "Person",
        preferredUsername: new URL(remote.actorUri).pathname.split("/").at(-1),
        inbox: `${remote.actorUri}/inbox`,
        outbox: `${remote.actorUri}/outbox`,
        featured: `${remote.actorUri}/collections/featured`,
        featuredTags: collection,
        publicKey: {
          id: `${remote.actorUri}#main-key`,
          owner: remote.actorUri,
          publicKeyPem: remote.publicKeyPem,
        },
      },
    ],
    [collection, { id: collection, type: "Collection", totalItems: items.length, items }],
  ]);
};

const runBackfill = async (remote: Remote): Promise<void> => {
  const job = OutboxJob.parse({ kind: "BackfillRemoteOutbox", actorUri: remote.actorUri });
  if (job.isErr()) {
    throw new Error("backfill job rejected");
  }
  expect(await processOutboxJob(env, job.value)).toBe("ok");
};

describe("GET /api/v1/accounts/:id/featured_tags for a remote account", () => {
  it("answers an empty list for a known remote account that features nothing", async () => {
    const remote = await remoteActor("featured-tags-remote");
    expect(await featuredTags(RemoteAccountId.encode(remote.actorUri))).toEqual({
      status: 200,
      body: [],
    });
  });

  it("answers 404 for a remote account this server does not know", async () => {
    const unknown = RemoteAccountId.encode("https://remote.example/users/featured-tags-unknown");
    expect((await featuredTags(unknown)).status).toBe(404);
  });
});

describe("a remote actor's featured hashtags", () => {
  it("are added and removed by Add and Remove of a Hashtag, with the actor's posts counted", async () => {
    const remote = await remoteActor("tag-featurer", "tags.example", {
      featuredUri: "https://tags.example/users/tag-featurer/collections/featured",
    });
    const note = {
      id: "https://tags.example/notes/cats-1",
      type: "Note",
      attributedTo: remote.actorUri,
      content: '<p><a href="https://tags.example/tags/cats" rel="tag">#<span>Cats</span></a></p>',
      tag: [hashtag(remote, "Cats")],
      published: "2024-05-01T10:00:00.000Z",
      to: [PUBLIC],
      cc: [`${remote.actorUri}/followers`],
    };
    expect(
      await remote.send({ id: `${note.id}/activity`, type: "Create", to: note.to, object: note }),
    ).toBe(202);

    expect(await sendAt(remote, tagActivity(remote, "Add", "Cats"), 50)).toBe(202);
    expect(await sendAt(remote, tagActivity(remote, "Add", "Dogs"), 40)).toBe(202);
    const handle = "tag-featurer@tags.example";
    expect(await featuredOf(remote)).toEqual([
      {
        id: expect.any(String),
        name: "Cats",
        url: `https://example.com/@${handle}/tagged/cats`,
        statuses_count: "1",
        last_status_at: "2024-05-01",
      },
      {
        id: expect.any(String),
        name: "Dogs",
        url: `https://example.com/@${handle}/tagged/dogs`,
        statuses_count: "0",
        last_status_at: null,
      },
    ]);

    expect(await sendAt(remote, tagActivity(remote, "Remove", "cats"), 30)).toBe(202);
    expect((await featuredOf(remote)).map((tag) => tag.name)).toEqual(["Dogs"]);
  });

  it("ignores a Hashtag added to a collection other than the actor's featured", async () => {
    const remote = await remoteActor("tag-elsewhere", "tags.example", {
      featuredUri: "https://tags.example/users/tag-elsewhere/collections/featured",
    });
    const activity = {
      ...tagActivity(remote, "Add", "Cats"),
      target: "https://tags.example/users/tag-elsewhere/collections/other",
    };
    expect(await sendAt(remote, activity, 10)).toBe(202);
    expect(await featuredOf(remote)).toEqual([]);
  });

  it("are read from the first ten items of the featuredTags collection on a profile backfill", async () => {
    const remote = await remoteActor("tag-collection", "tags.example");
    const names = Array.from({ length: 12 }, (_, index) => `Topic${index}`);
    const items = [
      { type: "Note", id: "https://tags.example/notes/not-a-tag" },
      ...names.map((name) => hashtag(remote, name)),
    ];
    await serving(featuredTagsDocuments(remote, items), () => runBackfill(remote));
    expect((await featuredOf(remote)).map((tag) => tag.name)).toEqual(names.slice(0, 9));

    expect(await sendAt(remote, tagActivity(remote, "Add", "Tenth"), 20)).toBe(202);
    expect(await featuredOf(remote)).toHaveLength(10);
    // An eleventh is not kept.
    expect(await sendAt(remote, tagActivity(remote, "Add", "Extra"), 10)).toBe(202);
    expect((await featuredOf(remote)).map((tag) => tag.name)).toEqual([
      ...names.slice(0, 9),
      "Tenth",
    ]);

    await serving(featuredTagsDocuments(remote, [hashtag(remote, "Topic3")]), () =>
      runBackfill(remote),
    );
    expect((await featuredOf(remote)).map((tag) => tag.name)).toEqual(["Topic3"]);
  });
});
