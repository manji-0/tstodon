import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { holdQueue, kindOf, withQueueDrained } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";
import { upsertRemoteActor } from "./remote-actor-store";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const REFRESH = "RefreshRemoteEmoji";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const Emojis = z.array(
  z.object({ shortcode: z.string(), url: z.string(), static_url: z.string() }),
);

const get = async (path: string): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`);
  expect(response.status).toBe(200);
  return response.json();
};

/** The image each custom emoji of a status shows, by shortcode. */
const statusEmojis = async (id: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    read(z.object({ emojis: Emojis }), await get(`/api/v1/statuses/${id}`)).emojis.map((emoji) => {
      expect(emoji.static_url).toBe(emoji.url);
      return [emoji.shortcode, emoji.url];
    }),
  );

const accountEmojis = async (actorUri: string): Promise<Record<string, string>> =>
  Object.fromEntries(
    read(
      z.object({ emojis: Emojis }),
      await get(`/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`),
    ).emojis.map((emoji) => [emoji.shortcode, emoji.url]),
  );

const historyEmojis = async (id: string): Promise<Array<Record<string, string>>> =>
  read(z.array(z.object({ emojis: Emojis })), await get(`/api/v1/statuses/${id}/history`)).map(
    (version) => Object.fromEntries(version.emojis.map((emoji) => [emoji.shortcode, emoji.url])),
  );

const emojiTag = (shortcode: string, url: string) => ({
  type: "Emoji",
  name: `:${shortcode}:`,
  icon: { type: "Image", mediaType: "image/png", url },
});

const noteOf = (
  author: Remote,
  slug: string,
  content: string,
  tag: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => ({
  id: `${new URL(author.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content,
  published: "2026-11-20T00:00:00.000Z",
  to: [PUBLIC],
  tag,
  ...extra,
});

/** `author` posts a public note; the id it is stored under here. */
const post = async (
  author: Remote,
  slug: string,
  content: string,
  tag: ReadonlyArray<Record<string, unknown>>,
): Promise<string> => {
  const object = noteOf(author, slug, content, tag);
  expect(await author.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);
  return read(
    z.object({ id: z.string() }),
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(object.id)
      .first(),
  ).id;
};

const updateProfile = async (actor: Remote, name: string, tag: ReadonlyArray<unknown>) => {
  expect(
    await actor.send({
      id: `${actor.actorUri}#updates/${crypto.randomUUID()}`,
      type: "Update",
      object: {
        id: actor.actorUri,
        type: "Person",
        preferredUsername: actor.actorUri.split("/").pop(),
        name,
        inbox: `${actor.actorUri}/inbox`,
        publicKey: {
          id: `${actor.actorUri}#main-key`,
          owner: actor.actorUri,
          publicKeyPem: actor.publicKeyPem,
        },
        tag,
      },
    }),
  ).toBe(202);
};

describe("a remote custom emoji whose image changes", () => {
  it("shows the new image on every post and profile of its server, as Mastodon's one emoji per server", async () => {
    const host = "emoji-change.example";
    const old = `https://${host}/system/blob-1.png`;
    const changed = `https://${host}/system/blob-2.png`;
    const other = `https://${host}/system/other.png`;
    const alice = await remoteActor("alice", host);
    const bob = await remoteActor("bob", host);
    const elsewhere = await remoteActor("carol", "emoji-elsewhere.example");

    const first = await post(alice, "first", "<p>:blob: :other:</p>", [
      emojiTag("blob", old),
      emojiTag("other", other),
    ]);
    const bobs = await post(bob, "bobs", "<p>:blob:</p>", [emojiTag("blob", old)]);
    const carols = await post(elsewhere, "carols", "<p>:blob:</p>", [emojiTag("blob", old)]);
    await updateProfile(bob, "Bob :blob:", [emojiTag("blob", old)]);
    expect(await accountEmojis(bob.actorUri)).toEqual({ blob: old });

    const second = await withQueueDrained([REFRESH], () =>
      post(alice, "second", "<p>:blob: again</p>", [emojiTag("blob", changed)]),
    );

    expect(await statusEmojis(second)).toEqual({ blob: changed });
    expect(await statusEmojis(first)).toEqual({ blob: changed, other });
    expect(await statusEmojis(bobs)).toEqual({ blob: changed });
    expect(await accountEmojis(bob.actorUri)).toEqual({ blob: changed });
    // Another server's emoji of the same name is its own.
    expect(await statusEmojis(carols)).toEqual({ blob: old });
  });

  it("shows the new image in an edited post's earlier versions", async () => {
    const host = "emoji-change-history.example";
    const old = `https://${host}/system/wave-1.png`;
    const changed = `https://${host}/system/wave-2.png`;
    const author = await remoteActor("dave", host);
    const id = await post(author, "edited", "<p>:wave:</p>", [emojiTag("wave", old)]);
    const object = noteOf(author, "edited", "<p>:wave: edited</p>", [emojiTag("wave", old)], {
      updated: "2026-11-21T00:00:00.000Z",
    });
    expect(await author.send({ id: `${object.id}/update`, type: "Update", object })).toBe(202);
    expect(await historyEmojis(id)).toEqual([{ wave: old }, { wave: old }]);

    await withQueueDrained([REFRESH], () =>
      post(author, "later", "<p>:wave:</p>", [emojiTag("wave", changed)]),
    );

    expect(await historyEmojis(id)).toEqual([{ wave: changed }, { wave: changed }]);
  });

  it("refreshes nothing when the image is the one already known", async () => {
    const host = "emoji-same.example";
    const url = `https://${host}/system/same.png`;
    const author = await remoteActor("erin", host);
    await post(author, "one", "<p>:same:</p>", [emojiTag("same", url)]);

    const held = holdQueue();
    try {
      await post(author, "two", "<p>:same:</p>", [emojiTag("same", url)]);
      await updateProfile(author, "Erin :same:", [emojiTag("same", url)]);
    } finally {
      held.release();
    }
    expect(held.bodies.map(kindOf)).not.toContain(REFRESH);
  });

  it("refreshes every actor of a server, a page at a time", async () => {
    const host = "emoji-change-many.example";
    const old = `https://${host}/system/many-1.png`;
    const changed = `https://${host}/system/many-2.png`;
    const author = await remoteActor("gina", host);
    const now = IsoInstant.parse(new Date().toISOString());
    if (now.isErr()) {
      throw new Error("invalid clock");
    }
    const others = Array.from({ length: 120 }, (_, index) => {
      const actorUri = `https://${host}/users/m${index}`;
      const actor = RemoteActor.fromFetched({
        actorUri,
        username: `m${index}`,
        domain: host,
        inboxUri: `${actorUri}/inbox`,
        displayName: ":many:",
        profile: { ...RemoteActor.emptyProfile, emojis: [{ shortcode: "many", url: old }] },
        fetchedAt: now.value,
      });
      if (actor.isErr()) {
        throw new Error("actor rejected");
      }
      return actor.value;
    });
    for (const actor of others) {
      expect((await upsertRemoteActor(env.DB, actor, [])).isOk()).toBe(true);
    }
    await post(author, "many-old", "<p>:many:</p>", [emojiTag("many", old)]);

    await withQueueDrained([REFRESH], () =>
      post(author, "many-new", "<p>:many:</p>", [emojiTag("many", changed)]),
    );

    const oldPost = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(`https://${host}/notes/many-old`)
      .first();
    expect(await statusEmojis(read(z.object({ id: z.string() }), oldPost).id)).toEqual({
      many: changed,
    });
    for (const index of [0, 49, 50, 99, 100, 119]) {
      const actor = others[index];
      if (actor === undefined) {
        throw new Error("missing actor");
      }
      expect(await accountEmojis(actor.actorUri)).toEqual({
        many: changed,
      });
    }
  });

  it("shows an image a profile update changes on the server's posts", async () => {
    const host = "emoji-change-profile.example";
    const old = `https://${host}/system/cat-1.png`;
    const changed = `https://${host}/system/cat-2.png`;
    const author = await remoteActor("frank", host);
    const id = await post(author, "cat", "<p>:cat:</p>", [emojiTag("cat", old)]);

    await withQueueDrained([REFRESH], () =>
      updateProfile(author, "Frank :cat:", [emojiTag("cat", changed)]),
    );

    expect(await accountEmojis(author.actorUri)).toEqual({ cat: changed });
    expect(await statusEmojis(id)).toEqual({ cat: changed });
  });
});
