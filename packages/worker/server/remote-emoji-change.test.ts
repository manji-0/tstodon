import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { holdQueue, kindOf, withQueueDrained } from "../test/queue-hold";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";
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

/** An `Emoji` tag; Mastodon dates each with the emoji's `updated_at`. */
const emojiTag = (shortcode: string, url: string, updated?: string) => ({
  type: "Emoji",
  name: `:${shortcode}:`,
  icon: { type: "Image", mediaType: "image/png", url },
  ...(updated === undefined ? {} : { updated }),
});

const refreshJobs = (bodies: ReadonlyArray<unknown>): number =>
  bodies.filter((body) => kindOf(body) === REFRESH).length;

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
    expect(refreshJobs(held.bodies)).toBe(0);
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

  // Mastodon keeps its stored image when the one a late delivery names does
  // not download, and the server has deleted the replaced file.
  it("keeps the newer image when a delivery dated before it comes later", async () => {
    const host = "emoji-change-late.example";
    const old = `https://${host}/system/late-1.png`;
    const changed = `https://${host}/system/late-2.png`;
    const author = await remoteActor("hana", host);
    const first = await post(author, "first", "<p>:late:</p>", [
      emojiTag("late", old, "2026-11-01T00:00:00Z"),
    ]);
    const second = await withQueueDrained([REFRESH], () =>
      post(author, "second", "<p>:late:</p>", [emojiTag("late", changed, "2026-11-10T00:00:00Z")]),
    );

    const held = holdQueue();
    let retried = "";
    try {
      retried = await post(author, "retried", "<p>:late:</p>", [
        emojiTag("late", old, "2026-11-01T00:00:00Z"),
      ]);
    } finally {
      held.release();
    }

    expect(refreshJobs(held.bodies)).toBe(0);
    expect(await statusEmojis(first)).toEqual({ late: changed });
    expect(await statusEmojis(second)).toEqual({ late: changed });
    expect(await statusEmojis(retried)).toEqual({ late: changed });
  });

  it("refreshes a server once for a note that changes several of its images", async () => {
    const host = "emoji-change-several.example";
    const author = await remoteActor("ivan", host);
    const image = (name: string) => `https://${host}/system/${name}.png`;
    const first = await post(author, "first", "<p>:one: :two:</p>", [
      emojiTag("one", image("one-1")),
      emojiTag("two", image("two-1")),
    ]);

    const held = holdQueue();
    try {
      await post(author, "second", "<p>:one: :two:</p>", [
        emojiTag("one", image("one-2")),
        emojiTag("two", image("two-2")),
      ]);
      await post(author, "third", "<p>:one: :two:</p>", [
        emojiTag("one", image("one-2")),
        emojiTag("two", image("two-2")),
      ]);
    } finally {
      held.release();
    }

    expect(refreshJobs(held.bodies)).toBe(1);
    await withQueueDrained([REFRESH], async () => {
      for (const body of held.bodies) {
        await env.OUTBOX_PROCESS_QUEUE.send(body);
      }
    });
    expect(await statusEmojis(first)).toEqual({ one: image("one-2"), two: image("two-2") });
  });

  it("ends a refresh that a newer image overtook, and shows the newest one", async () => {
    const host = "emoji-change-overtaken.example";
    const image = (n: number) => `https://${host}/system/fast-${n}.png`;
    const author = await remoteActor("jun", host);
    const first = await post(author, "first", "<p>:fast:</p>", [emojiTag("fast", image(1))]);

    await withQueueDrained([REFRESH], async () => {
      await post(author, "second", "<p>:fast:</p>", [emojiTag("fast", image(2))]);
      await post(author, "third", "<p>:fast:</p>", [emojiTag("fast", image(3))]);
    });

    expect(await statusEmojis(first)).toEqual({ fast: image(3) });
  });

  it("refreshes an actor with more posts than a page, a page of posts at a time", async () => {
    const host = "emoji-change-prolific.example";
    const old = `https://${host}/system/busy-1.png`;
    const changed = `https://${host}/system/busy-2.png`;
    const author = await remoteActor("kai", host);
    const first = await post(author, "first", "<p>:busy:</p>", [emojiTag("busy", old)]);
    const copies = 450;
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO remote_statuses (id, actor_uri, object_uri, content_html, visibility, published_at, emojis_json)
       SELECT CAST(CAST(s.id AS INTEGER) + n.i AS TEXT), s.actor_uri, s.object_uri || '/' || n.i,
         s.content_html, s.visibility, s.published_at, s.emojis_json
       FROM remote_statuses s, n WHERE s.id = ?1`,
    )
      .bind(first, copies)
      .run();
    const copy = (n: number) => (BigInt(first) + BigInt(n)).toString();

    await withQueueDrained([REFRESH], () =>
      post(author, "second", "<p>:busy:</p>", [emojiTag("busy", changed)]),
    );

    for (const id of [first, copy(1), copy(199), copy(200), copy(201), copy(copies)]) {
      expect(await statusEmojis(id)).toEqual({ busy: changed });
    }
  });

  it("starts a refresh that could not be queued from the hourly cron", async () => {
    const host = "emoji-change-unqueued.example";
    const old = `https://${host}/system/lost-1.png`;
    const changed = `https://${host}/system/lost-2.png`;
    const author = await remoteActor("lena", host);
    const first = await post(author, "first", "<p>:lost:</p>", [emojiTag("lost", old)]);

    const proto = Object.getPrototypeOf(env.OUTBOX_PROCESS_QUEUE);
    const send = vi.spyOn(proto, "send").mockImplementation((body: unknown) => {
      if (kindOf(body) === REFRESH) {
        throw new Error("queue unavailable");
      }
    });
    try {
      await post(author, "second", "<p>:lost:</p>", [emojiTag("lost", changed)]);
    } finally {
      send.mockRestore();
    }
    expect(await statusEmojis(first)).toEqual({ lost: old });

    await withQueueDrained([REFRESH], () =>
      processOutboxJob(env, { kind: "ResumeRemoteEmojiRefreshes" }),
    );

    expect(await statusEmojis(first)).toEqual({ lost: changed });
  });

  // `skip_download?`: Mastodon stores no emoji of a domain whose media it rejects.
  it("records no image of a server whose media is rejected", async () => {
    const host = "emoji-change-rejected.example";
    const old = `https://${host}/system/no-1.png`;
    const changed = `https://${host}/system/no-2.png`;
    const blocked = await SELF.fetch("https://example.com/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: {
        ...(await authHeaders("emoji-reject-admin@example.com", { admin: true })),
        "content-type": "application/json",
      },
      body: JSON.stringify({ domain: host, severity: "noop", reject_media: true }),
    });
    expect(blocked.status).toBe(200);
    await blocked.arrayBuffer();
    const author = await remoteActor("mio", host);
    const first = await post(author, "first", "<p>:no:</p>", [emojiTag("no", old)]);

    const held = holdQueue();
    try {
      await post(author, "second", "<p>:no:</p>", [emojiTag("no", changed)]);
    } finally {
      held.release();
    }

    expect(refreshJobs(held.bodies)).toBe(0);
    expect(await statusEmojis(first)).toEqual({ no: old });
  });
});
