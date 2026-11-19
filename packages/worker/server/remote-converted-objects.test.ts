import { SELF, env } from "cloudflare:test";
import { ApiSearchResults, ApiStatus, type ApiStatusJSON } from "@tstodon/api";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { answerLinkPreviews } from "../test/link-card-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon v4.7.5 stores the objects of `ActivityPub::Activity::CONVERTED_TYPES`
// (`Image`, `Audio`, `Video`, `Article`, `Page`, `Event`) as statuses whose
// text is the object's name, its summary and a link to it
// (`StatusParser#processed_text`), with the media of its `attachment`. The
// documents below follow the shapes each project sends.

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** A 4x3-component BlurHash. */
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

/** Mastodon's `TextFormatter.shortened_link` of `url`, in the paragraph `linkify` wraps it in. */
const link = (url: string): string => {
  const prefix = /^https?:\/\/(?:www\.)?/.exec(url)?.[0] ?? "";
  const rest = url.slice(prefix.length);
  // A one-character suffix is shown rather than hidden behind the ellipsis.
  const cut = rest.length === 31 ? 31 : 30;
  const shown = rest.slice(0, cut);
  const hidden = rest.slice(cut);
  return `<p><a href="${url}" target="_blank" rel="nofollow noopener" translate="no"><span class="invisible">${prefix}</span><span class="${hidden.length > 0 ? "ellipsis" : ""}">${shown}</span><span class="invisible">${hidden}</span></a></p>`;
};

type ApObject = Readonly<{ id: string; [property: string]: unknown }>;

type Software = Readonly<{
  /** The project whose document shape this is. */
  name: string;
  type: string;
  actor: () => Promise<Remote>;
  /** The object, published `published`; `key` tells the objects of one test file apart. */
  object: (author: Remote, published: string, key: string) => ApObject;
  /** The text Mastodon stores for the object `key`. */
  text: (key: string) => string;
  media: ReadonlyArray<Record<string, unknown>>;
  /** The `href` of its `Link` attachment, unfurled in place of its text's link. */
  cardUrl?: string;
  /** How its `Delete` names the object. */
  deleted: (objectUri: string) => unknown;
}>;

/** WriteFreely: a blog post, an `Article` sent by the blog's actor (`activitystreams.Article`). */
const writefreely: Software = {
  name: "WriteFreely",
  type: "Article",
  actor: () => remoteActor("matt", "write.fed4.org", { path: "/api/collections/matt" }),
  object: (author, published, key) => ({
    type: "Article",
    id: `https://write.fed4.org/api/posts/fed4${key}`,
    attributedTo: author.actorUri,
    published,
    inReplyTo: null,
    url: `https://write.fed4.org/matt/long-form-${key}`,
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
    name: "On long-form federation",
    content: "<p>Every paragraph of the essay.</p><p>#fediverse</p>",
    contentMap: { en: "<p>Every paragraph of the essay.</p><p>#fediverse</p>" },
    tag: [
      { type: "Hashtag", href: "https://write.fed4.org/matt/tag:fediverse", name: "#fediverse" },
    ],
    sensitive: false,
  }),
  text: (key) =>
    `<h2>On long-form federation</h2>\n\n${link(`https://write.fed4.org/matt/long-form-${key}`)}`,
  media: [],
  deleted: (objectUri) => ({ type: "Tombstone", id: objectUri }),
};

/** Lemmy: a post, a `Page` whose link is an `attachment` of type `Link`; it has no `url`. */
const lemmy: Software = {
  name: "Lemmy",
  type: "Page",
  actor: () => remoteActor("alice", "lemmy.fed4.org", { path: "/u/alice" }),
  object: (author, published, key) => ({
    type: "Page",
    id: `https://lemmy.fed4.org/post/4242${key}`,
    attributedTo: author.actorUri,
    to: ["https://lemmy.fed4.org/c/fediverse", PUBLIC],
    cc: [],
    audience: "https://lemmy.fed4.org/c/fediverse",
    name: "Which servers convert Pages?",
    content: "<p>Asking for a friend.</p>\n",
    mediaType: "text/html",
    source: { content: "Asking for a friend.", mediaType: "text/markdown" },
    attachment: [{ type: "Link", href: "https://example.org/article" }],
    image: { type: "Image", url: "https://lemmy.fed4.org/pictrs/image/thumb.jpg" },
    sensitive: false,
    published,
    language: { identifier: "en", name: "English" },
  }),
  text: (key) =>
    `<h2>Which servers convert Pages?</h2>\n\n${link(`https://lemmy.fed4.org/post/4242${key}`)}`,
  media: [],
  cardUrl: "https://example.org/article",
  deleted: (objectUri) => objectUri,
};

/**
 * PeerTube: a `Video` sent by the uploader's account, its `url` a list of
 * links (the watch page first, then the streams) and `attributedTo` the
 * account and the channel. Its streams are no `attachment`, so Mastodon shows
 * no media.
 */
const peertube: Software = {
  name: "PeerTube",
  type: "Video",
  actor: () => remoteActor("root", "peertube.fed4.org", { path: "/accounts/root" }),
  object: (author, published, key) => {
    const id = `https://peertube.fed4.org/videos/watch/9c9de5e8-0a1e-484a-b099-e80766180a6${key}`;
    return {
      type: "Video",
      id,
      name: "What is PeerTube?",
      duration: "PT300S",
      uuid: "9c9de5e8-0a1e-484a-b099-e80766180a6d",
      tag: [{ type: "Hashtag", name: "peertube" }],
      category: { identifier: "15", name: "Science & Technology" },
      licence: { identifier: "1", name: "Attribution" },
      language: { identifier: "en", name: "English" },
      views: 0,
      sensitive: false,
      waitTranscoding: false,
      state: 1,
      commentsEnabled: true,
      downloadEnabled: true,
      published,
      originallyPublishedAt: null,
      updated: published,
      mediaType: "text/markdown",
      content: "A short introduction to **PeerTube**.",
      support: null,
      subtitleLanguage: [],
      icon: [
        {
          type: "Image",
          url: "https://peertube.fed4.org/lazy-static/thumbnails/9c9de5e8.jpg",
          mediaType: "image/jpeg",
          width: 280,
          height: 157,
        },
      ],
      url: [
        { type: "Link", mediaType: "text/html", href: `https://peertube.fed4.org/w/kkGMgK9${key}` },
        {
          type: "Link",
          mediaType: "application/x-mpegURL",
          href: "https://peertube.fed4.org/static/streaming-playlists/hls/9c9de5e8/master.m3u8",
          tag: [],
        },
        {
          type: "Link",
          mediaType: "video/mp4",
          href: "https://peertube.fed4.org/static/web-videos/9c9de5e8-720.mp4",
          height: 720,
          size: 10_000_000,
          fps: 30,
        },
      ],
      likes: `${id}/likes`,
      dislikes: `${id}/dislikes`,
      shares: `${id}/announces`,
      comments: `${id}/comments`,
      attributedTo: [
        { type: "Person", id: author.actorUri },
        { type: "Group", id: "https://peertube.fed4.org/video-channels/root_channel" },
      ],
      to: [PUBLIC],
      cc: [`${author.actorUri}/followers`],
    };
  },
  text: (key) =>
    `<h2>What is PeerTube?</h2>\n\n${link(`https://peertube.fed4.org/w/kkGMgK9${key}`)}`,
  media: [],
  deleted: (objectUri) => objectUri,
};

/**
 * Funkwhale: a channel's track, an `Audio` whose `url` links name their
 * `mimeType`, so Mastodon links the `text/html` one; its `summary` lists the
 * track's tags.
 */
const funkwhale: Software = {
  name: "Funkwhale",
  type: "Audio",
  actor: () => remoteActor("jazz", "fw.fed4.org", { path: "/federation/actors/jazz" }),
  object: (author, published, key) => ({
    type: "Audio",
    id: `https://fw.fed4.org/federation/music/uploads/64041a88-ed42-4d0b-a4b5-0b1a6b8da2c${key}`,
    name: "Night Walk",
    attributedTo: author.actorUri,
    published,
    to: PUBLIC,
    url: [
      {
        type: "Link",
        mimeType: "audio/ogg",
        href: "https://fw.fed4.org/api/v1/listen/3c1b5e05/?upload=64041a88",
      },
      { type: "Link", mimeType: "text/html", href: `https://fw.fed4.org/library/tracks/42${key}` },
    ],
    duration: 43,
    mediaType: "text/html",
    content: "<p>Recorded live.</p>",
    summary: "#jazz #live",
    tag: [
      { type: "Hashtag", name: "#jazz" },
      { type: "Hashtag", name: "#live" },
    ],
    icon: {
      type: "Image",
      mediaType: "image/jpeg",
      url: "https://fw.fed4.org/media/attachments/cover.jpg",
    },
  }),
  text: (key) =>
    `<h2>Night Walk</h2>\n\n#jazz #live\n\n${link(`https://fw.fed4.org/library/tracks/42${key}`)}`,
  media: [],
  deleted: (objectUri) => ({ type: "Tombstone", id: objectUri, formerType: "Audio" }),
};

/** Mobilizon: an `Event`, its banner a `Document` in `attachment`. */
const mobilizon: Software = {
  name: "Mobilizon",
  type: "Event",
  actor: () => remoteActor("tcit", "mobilizon.fed4.org", { path: "/@tcit" }),
  object: (author, published, key) => {
    const id = `https://mobilizon.fed4.org/events/2a1b3c4d-5e6f-4a5b-8c7d-9e0f1a2b3c4${key}`;
    return {
      type: "Event",
      id,
      uuid: "2a1b3c4d-5e6f-4a5b-8c7d-9e0f1a2b3c4d",
      url: id,
      name: "Fediverse meetup",
      attributedTo: author.actorUri,
      actor: author.actorUri,
      content: "<p>Bring a laptop.</p>",
      mediaType: "text/html",
      startTime: "2026-12-01T18:00:00Z",
      endTime: "2026-12-01T21:00:00Z",
      location: { type: "Place", name: "Public library" },
      category: "MEETING",
      anonymousParticipationEnabled: false,
      joinMode: "free",
      commentsEnabled: true,
      draft: false,
      "ical:status": "CONFIRMED",
      isOnline: false,
      maximumAttendeeCapacity: 0,
      participantCount: 1,
      published,
      updated: published,
      tag: [{ type: "Hashtag", href: "https://mobilizon.fed4.org/tags/meetup", name: "#meetup" }],
      attachment: [
        {
          type: "Document",
          mediaType: "image/jpeg",
          name: "Banner",
          url: "https://mobilizon.fed4.org/media/banner.jpg",
        },
      ],
      to: [PUBLIC],
      cc: [`${author.actorUri}/followers`],
    };
  },
  text: (key) =>
    `<h2>Fediverse meetup</h2>\n\n${link(`https://mobilizon.fed4.org/events/2a1b3c4d-5e6f-4a5b-8c7d-9e0f1a2b3c4${key}`)}`,
  media: [
    {
      type: "image",
      remote_url: "https://mobilizon.fed4.org/media/banner.jpg",
      description: "Banner",
    },
  ],
  deleted: (objectUri) => ({ type: "Tombstone", id: objectUri }),
};

/**
 * An `Image` whose file is listed in its `attachment`, in the shape Pixelfed
 * gives a post's media. Its `summary` is no content warning: Mastodon puts it
 * in the text, and `sensitive` alone marks the status.
 */
const image: Software = {
  name: "an image host",
  type: "Image",
  actor: () => remoteActor("dansup", "pixelfed.fed4.org"),
  object: (author, published, key) => ({
    type: "Image",
    id: `https://pixelfed.fed4.org/p/dansup/7843${key}`,
    name: "Sunset over the bay",
    summary: "bright",
    attributedTo: author.actorUri,
    published,
    url: `https://pixelfed.fed4.org/p/dansup/7843${key}`,
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
    sensitive: true,
    attachment: [
      {
        type: "Image",
        mediaType: "image/jpeg",
        url: "https://pixelfed.fed4.org/storage/m/sunset.jpg",
        name: "The sun setting over the bay",
        blurhash: BLURHASH,
        width: 1080,
        height: 1350,
      },
    ],
  }),
  text: (key) =>
    `<h2>Sunset over the bay</h2>\n\nbright\n\n${link(`https://pixelfed.fed4.org/p/dansup/7843${key}`)}`,
  media: [
    {
      type: "image",
      remote_url: "https://pixelfed.fed4.org/storage/m/sunset.jpg",
      description: "The sun setting over the bay",
      blurhash: BLURHASH,
      meta: { original: { width: 1080, height: 1350 } },
    },
  ],
  deleted: (objectUri) => objectUri,
};

const SOFTWARE: ReadonlyArray<Software> = [
  writefreely,
  lemmy,
  peertube,
  funkwhale,
  mobilizon,
  image,
];

const storedRow = async (objectUri: string) =>
  parseRows(
    z.object({ id: z.string(), content_html: z.string(), spoiler_text: z.string() }),
    (
      await env.DB.prepare(
        "SELECT id, content_html, spoiler_text FROM remote_statuses WHERE object_uri = ?",
      )
        .bind(objectUri)
        .all()
    ).results,
  )[0];

const storedId = async (objectUri: string): Promise<string> => {
  const row = await storedRow(objectUri);
  if (!row) {
    throw new Error(`${objectUri} was not stored`);
  }
  return row.id;
};

const status = async (id: string): Promise<ApiStatusJSON> => {
  const response = await SELF.fetch(`https://example.com/api/v1/statuses/${id}`);
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

/** `email` follows `remote`, which accepts. Gives the follower's request headers. */
const acceptedFollow = async (email: string, remote: Remote) => {
  const headers = await authHeaders(email);
  const followed = await SELF.fetch(
    `https://example.com/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" },
  );
  expect(followed.status).toBe(200);
  const row = parseRows(
    z.object({ follow_activity_id: z.string() }),
    (
      await env.DB.prepare("SELECT follow_activity_id FROM outbound_follows WHERE actor_uri = ?")
        .bind(remote.actorUri)
        .all()
    ).results,
  )[0];
  if (!row) {
    throw new Error("no follow was sent");
  }
  expect(
    await remote.send({
      id: `${remote.actorUri}#accepts/follow`,
      type: "Accept",
      object: row.follow_activity_id,
    }),
  ).toBe(202);
  return headers;
};

const homeIds = async (headers: Record<string, string>): Promise<string[]> => {
  const response = await SELF.fetch("https://example.com/api/v1/timelines/home", { headers });
  expect(response.status).toBe(200);
  return parseRows(z.object({ id: z.string() }), await response.json()).map((entry) => entry.id);
};

/** Serve `documents` by URL to the Worker's outbound fetches while `run` runs. */
const serving = async <T>(
  documents: Readonly<Record<string, unknown>>,
  run: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents[href];
    return document === undefined
      ? original(input, init)
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

/**
 * Answer the preview fetch of `software`'s object `key`: storing the status
 * unfurls its `Link` attachment, or else the link its text ends with, as
 * Mastodon's `LinkCrawlWorker` with `@links.first`.
 */
const previewOf = (software: Software, key: string) =>
  answerLinkPreviews([software.cardUrl ?? /href="([^"]+)"/.exec(software.text(key))?.[1] ?? ""]);

describe.each(SOFTWARE)("a $type from $name", (software) => {
  it("is stored by its Create as Mastodon converts it, and reaches a follower's home", async () => {
    const previews = previewOf(software, "1");
    const author = await software.actor();
    const headers = await acceptedFollow(`fed4-${software.type.toLowerCase()}@example.com`, author);
    const object = software.object(author, hoursAgo(1), "1");
    const objectUri = object.id;
    expect(
      await author.send({ id: `${objectUri}#create`, type: "Create", object, to: object.to }),
    ).toBe(202);

    const row = await storedRow(objectUri);
    expect(row?.content_html).toBe(software.text("1"));
    expect(row?.spoiler_text).toBe("");
    const id = await storedId(objectUri);
    const shown = await status(id);
    expect(shown.uri).toBe(objectUri);
    expect(shown.spoiler_text).toBe("");
    expect(shown.sensitive).toBe(object.sensitive === true);
    expect(shown.edited_at).toBeNull();
    expect(shown.media_attachments).toHaveLength(software.media.length);
    software.media.forEach((media, index) => {
      expect(shown.media_attachments[index]).toMatchObject(media);
    });
    expect(await homeIds(headers)).toContain(id);
    await previews.settled();
  });

  it("is edited by its Update", async () => {
    const previews = previewOf(software, "2");
    const author = await software.actor();
    const object = software.object(author, hoursAgo(2), "2");
    const objectUri = object.id;
    expect(await author.send({ id: `${objectUri}#create-to-edit`, type: "Create", object })).toBe(
      202,
    );
    const id = await storedId(objectUri);
    const updated = hoursAgo(1);
    expect(
      await author.send({
        id: `${objectUri}#update/${updated}`,
        type: "Update",
        object: { ...object, name: "Renamed", updated },
      }),
    ).toBe(202);

    const shown = await status(id);
    expect(shown.edited_at).not.toBeNull();
    expect((await storedRow(objectUri))?.content_html).toBe(
      software.text("2").replace(/^<h2>[^<]*<\/h2>/, "<h2>Renamed</h2>"),
    );
    await previews.settled();
  });

  it("is stored by an Update that arrives before its Create", async () => {
    const previews = previewOf(software, "3");
    const author = await software.actor();
    const object = { ...software.object(author, hoursAgo(3), "3"), updated: hoursAgo(1) };
    const objectUri = object.id;
    expect(await author.send({ id: `${objectUri}#early-update`, type: "Update", object })).toBe(
      202,
    );
    expect((await storedRow(objectUri))?.content_html).toBe(software.text("3"));
    await previews.settled();
  });

  it("is removed by its Delete", async () => {
    const previews = previewOf(software, "4");
    const author = await software.actor();
    const object = software.object(author, hoursAgo(1), "4");
    const objectUri = object.id;
    expect(await author.send({ id: `${objectUri}#create-to-delete`, type: "Create", object })).toBe(
      202,
    );
    const id = await storedId(objectUri);
    await previews.settled();
    expect(
      await author.send({
        id: `${objectUri}#delete`,
        type: "Delete",
        object: software.deleted(objectUri),
      }),
    ).toBe(202);
    expect(await storedRow(objectUri)).toBeUndefined();
    expect((await SELF.fetch(`https://example.com/api/v1/statuses/${id}`)).status).toBe(404);
  });

  it("is found by a search that resolves its URI", async () => {
    const previews = previewOf(software, "5");
    const author = await software.actor();
    const object = {
      "@context": "https://www.w3.org/ns/activitystreams",
      ...software.object(author, hoursAgo(1), "5"),
    };
    const objectUri = object.id;
    const found = await serving({ [objectUri]: object }, async () => {
      const response = await SELF.fetch(
        `https://example.com/api/v2/search?${new URLSearchParams({ q: objectUri, resolve: "true", type: "statuses" }).toString()}`,
        { headers: await authHeaders(`fed4-search-${software.type.toLowerCase()}@example.com`) },
      );
      expect(response.status).toBe(200);
      return expectContract(ApiSearchResults, await response.json());
    });
    expect(found.statuses.map((entry) => entry.uri)).toEqual([objectUri]);
    expect((await storedRow(objectUri))?.content_html).toBe(software.text("5"));
    await previews.settled();
  });
});

describe("a converted object", () => {
  it("drops the content of an Article, as Mastodon does, and reads its language", async () => {
    const previews = previewOf(writefreely, "6");
    const author = await writefreely.actor();
    const object = writefreely.object(author, hoursAgo(1), "6");
    expect(await author.send({ id: `${object.id}#create`, type: "Create", object })).toBe(202);
    const shown = await status(await storedId(object.id));
    expect(shown.content).not.toContain("Every paragraph");
    expect(shown.content).toContain("<p><strong>On long-form federation</strong></p>");
    expect(shown.language).toBe("en");
    expect(shown.tags.map((tag) => tag.name)).toEqual(["fediverse"]);
    await previews.settled();
  });

  it("threads a reply and notifies the local account it mentions, as a Note", async () => {
    const previews = previewOf(lemmy, "7");
    const email = "fed4-mentioned@example.com";
    const headers = await authHeaders(email);
    const me = parseRows(z.object({ username: z.string() }), [
      await (
        await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", { headers })
      ).json(),
    ])[0];
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "Which servers convert Pages?" }),
    });
    const parent = expectContract(ApiStatus, await posted.json());
    const localActor = `https://example.com/users/${me?.username ?? ""}`;
    const author = await lemmy.actor();
    const object = {
      ...lemmy.object(author, hoursAgo(1), "7"),
      inReplyTo: parent.uri,
      cc: [localActor],
      tag: [{ type: "Mention", href: localActor, name: `@${me?.username ?? ""}@example.com` }],
    };
    expect(await author.send({ id: `${object.id}#create`, type: "Create", object })).toBe(202);

    const shown = await status(await storedId(object.id));
    expect(shown.in_reply_to_id).toBe(parent.id);
    expect(shown.mentions.map((mention) => mention.username)).toEqual([me?.username]);
    const notifications = parseRows(
      z.object({ type: z.string(), status: z.object({ uri: z.string() }).optional() }),
      await (await SELF.fetch("https://example.com/api/v1/notifications", { headers })).json(),
    );
    expect(
      notifications.some((entry) => entry.type === "mention" && entry.status?.uri === object.id),
    ).toBe(true);
    await previews.settled();
  });
});

// Mastodon's `StatusParser#url`: `url_to_href(url, 'text/html')`, kept only
// when its scheme is http or https.
describe("a Note's url", () => {
  const storedUrl = async (url: unknown, slug: string): Promise<string | null | undefined> => {
    const author = await remoteActor("note-url", "note-url.example");
    const objectUri = `https://note-url.example/notes/${slug}`;
    expect(
      await author.send({
        id: `${objectUri}#create`,
        type: "Create",
        object: {
          id: objectUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: `<p>${slug}</p>`,
          published: hoursAgo(1),
          to: [PUBLIC],
          url,
        },
      }),
    ).toBe(202);
    return parseRows(
      z.object({ url: z.string().nullable() }),
      (
        await env.DB.prepare("SELECT url FROM remote_statuses WHERE object_uri = ?")
          .bind(objectUri)
          .all()
      ).results,
    )[0]?.url;
  };

  it("is dropped when relative, and the note stored", async () => {
    expect(await storedUrl("/relative", "relative")).toBeNull();
  });

  it("is dropped when it is no http(s) URL, and the note stored", async () => {
    expect(await storedUrl("javascript:alert(1)", "javascript")).toBeNull();
  });

  it("is the href of a Link", async () => {
    expect(await storedUrl([{ type: "Link", href: "https://note-url.example/@a/1" }], "link")).toBe(
      "https://note-url.example/@a/1",
    );
  });

  it("is a string listed after a Link of another mimeType", async () => {
    expect(
      await storedUrl(
        [
          { type: "Link", href: "https://note-url.example/a.mp4", mimeType: "video/mp4" },
          "https://note-url.example/watch",
        ],
        "string-after-link",
      ),
    ).toBe("https://note-url.example/watch");
  });
});
