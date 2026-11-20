import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { RemoteActor, IsoInstant } from "@tstodon/domain";
import { nowIso } from "./clock";
import { parseInstanceIdentity } from "./runtime-config";
import { findRemoteActorsByUris, upsertRemoteActor } from "./remote-actor-store";
import { applyRemoteUpdate } from "./remote-update";
import { persistRemoteObject } from "./remote-status-persist";
import { findRemoteStatusByObjectUri } from "./remote-status-store";
import { authHeaders } from "../test/auth-fixture";
import { unsignedFetch } from "./federated-fetch";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";

const auth = (email: string): Promise<Record<string, string>> =>
  authHeaders(email, { admin: true });

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const MediaSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  url: z.string().min(1),
  preview_url: z.string().min(1).nullable(),
  remote_url: z.string().nullable(),
  description: z.string().nullable(),
});

const RemoteStatusSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  spoiler_text: z.string(),
  media_attachments: z.array(MediaSchema),
  account: z.object({ acct: z.string().min(1) }),
});

const seedRemoteActor = async (actorUri: string, username: string, domain: string) => {
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    throw new Error("clock");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username,
    domain,
    inboxUri: `${actorUri}/inbox`,
    displayName: username,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("actor fixture rejected");
  }
  const stored = await upsertRemoteActor(env.DB, actor.value, []);
  expect(stored.isOk()).toBe(true);
  return actor.value;
};

describe("remote status media", () => {
  it("renders attachments captured from the ActivityPub note", async () => {
    const actorUri = "https://media-remote.example/users/carol";
    const actor = await seedRemoteActor(actorUri, "carol", "media-remote.example");
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("identity");
    }

    const persisted = await persistRemoteObject(
      env,
      identity.value,
      actor,
      {
        id: `${actorUri}/statuses/1`,
        type: "Note",
        attributedTo: actorUri,
        content: "<p>look at this</p>",
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        attachment: [
          {
            type: "Document",
            mediaType: "image/png",
            url: "https://media-remote.example/a.png",
            name: "alt text",
          },
          { type: "Document", mediaType: "video/mp4", url: "https://media-remote.example/b.mp4" },
          { type: "Document", url: "https://media-remote.example/no-type" },
        ],
      },
      { fetchSigner: unsignedFetch },
    );
    expect(persisted.isOk()).toBe(true);
    expect(persisted.isOk() ? persisted.value : undefined).toBeDefined();

    const timeline = await json("/api/v1/timelines/public");
    expect(timeline.status).toBe(200);
    const status = read(z.array(RemoteStatusSchema), timeline.body).find(
      (entry) => entry.account.acct === "carol@media-remote.example",
    );
    expect(status).toBeDefined();
    const media = status?.media_attachments ?? [];
    expect(media.map((attachment) => attachment.type)).toEqual(["image", "video", "unknown"]);
    expect(media[0]?.description).toBe("alt text");
    expect(media[1]?.description).toBeNull();
    expect(media[0]?.remote_url).toBe("https://media-remote.example/a.png");
    expect(media.map((attachment) => attachment.id)).toEqual([
      `${status?.id}-0`,
      `${status?.id}-1`,
      `${status?.id}-2`,
    ]);
  });

  it("caps attachments at four and defaults an unknown media type", async () => {
    const actorUri = "https://media-many.example/users/dave";
    const actor = await seedRemoteActor(actorUri, "dave", "media-many.example");
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("identity");
    }

    const persisted = await persistRemoteObject(
      env,
      identity.value,
      actor,
      {
        id: `${actorUri}/statuses/2`,
        type: "Note",
        attributedTo: actorUri,
        content: "<p>many</p>",
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        attachment: Array.from({ length: 6 }, (_, index) => ({
          type: "Document",
          mediaType: "audio/mpeg",
          url: `https://media-many.example/${index}.mp3`,
        })),
      },
      { fetchSigner: unsignedFetch },
    );
    expect(persisted.isOk()).toBe(true);
    const stored = persisted.isOk() ? persisted.value : undefined;
    expect(stored?.kind === "RemoteNote" ? stored.media.length : 0).toBe(4);
  });
});

describe("remote media as Mastodon's REST MediaAttachment", () => {
  const persistNote = async (host: string, attachment: ReadonlyArray<unknown>, slug = "media") => {
    const actorUri = `https://${host}/users/erin`;
    const actor = await seedRemoteActor(actorUri, "erin", host);
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("identity");
    }
    const persisted = await persistRemoteObject(
      env,
      identity.value,
      actor,
      {
        id: `${actorUri}/statuses/${slug}`,
        type: "Note",
        attributedTo: actorUri,
        content: "<p>media</p>",
        published: new Date().toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        attachment,
      },
      { fetchSigner: unsignedFetch },
    );
    if (persisted.isErr() || persisted.value === undefined) {
      throw new Error("note not stored");
    }
    const shown = await json(`/api/v1/statuses/${persisted.value.id}`);
    expect(shown.status).toBe(200);
    return expectContract(ApiStatus, shown.body).media_attachments;
  };

  it("serves a video's or an audio's thumbnail (`icon`) as its preview", async () => {
    const media = await persistNote("media-thumbs.example", [
      {
        type: "Document",
        mediaType: "video/mp4",
        url: "https://media-thumbs.example/clip.mp4",
        icon: {
          type: "Image",
          mediaType: "image/jpeg",
          url: "https://media-thumbs.example/clip.jpg",
        },
      },
      {
        type: "Document",
        mediaType: "audio/mpeg",
        url: "https://media-thumbs.example/song.mp3",
        icon: "https://media-thumbs.example/cover.png",
      },
      { type: "Document", mediaType: "video/webm", url: "https://media-thumbs.example/bare.webm" },
      { type: "Document", mediaType: "image/png", url: "https://media-thumbs.example/pic.png" },
    ]);
    expect(
      media.map(({ type, url, preview_url, remote_url, preview_remote_url, text_url }) => ({
        type,
        url,
        preview_url,
        remote_url,
        preview_remote_url,
        text_url,
      })),
    ).toEqual([
      {
        type: "video",
        url: "https://media-thumbs.example/clip.mp4",
        preview_url: "https://media-thumbs.example/clip.jpg",
        remote_url: "https://media-thumbs.example/clip.mp4",
        preview_remote_url: "https://media-thumbs.example/clip.jpg",
        text_url: null,
      },
      {
        type: "audio",
        url: "https://media-thumbs.example/song.mp3",
        preview_url: "https://media-thumbs.example/cover.png",
        remote_url: "https://media-thumbs.example/song.mp3",
        preview_remote_url: "https://media-thumbs.example/cover.png",
        text_url: null,
      },
      // No thumbnail, and no downloaded file to take a frame from: no
      // preview, so a client shows its placeholder, not the video as an image.
      {
        type: "video",
        url: "https://media-thumbs.example/bare.webm",
        preview_url: null,
        remote_url: "https://media-thumbs.example/bare.webm",
        preview_remote_url: null,
        text_url: null,
      },
      {
        type: "image",
        url: "https://media-thumbs.example/pic.png",
        preview_url: "https://media-thumbs.example/pic.png",
        remote_url: "https://media-thumbs.example/pic.png",
        preview_remote_url: null,
        text_url: null,
      },
    ]);
  });

  it("types an attachment by the media types Mastodon accepts", async () => {
    const entries = [
      ["image/gif", "image"],
      ["image/webp", "image"],
      ["video/quicktime", "video"],
      ["video/ogg", "video"],
      ["audio/ogg", "audio"],
      ["audio/x-m4a", "audio"],
      ["video/x-ms-asf", "audio"],
      ["image/svg+xml", "unknown"],
      ["video/x-matroska", "unknown"],
      ["audio/midi", "unknown"],
    ] as const;
    const types: string[] = [];
    // A note keeps four attachments.
    for (let start = 0; start < entries.length; start += 4) {
      const media = await persistNote(
        "media-types.example",
        entries.slice(start, start + 4).map(([mediaType], index) => ({
          type: "Document",
          mediaType,
          url: `https://media-types.example/${start + index}`,
        })),
        `types-${start}`,
      );
      types.push(...media.map((attachment) => attachment.type));
    }
    expect(types).toEqual(entries.map(([, type]) => type));
  });

  it("records a new thumbnail in an Update as an edit, as Mastodon's significantly_changes?", async () => {
    const host = "media-thumb-edit.example";
    const actorUri = `https://${host}/users/erin`;
    const [video] = await persistNote(host, [
      {
        type: "Document",
        mediaType: "video/mp4",
        url: `https://${host}/clip.mp4`,
        icon: `https://${host}/first.jpg`,
      },
    ]);
    const identity = parseInstanceIdentity(env);
    const signer = await findRemoteActorsByUris(env.DB, [actorUri]);
    const actor = signer.isOk() ? signer.value.get(actorUri) : undefined;
    if (identity.isErr() || actor === undefined) {
      throw new Error("fixture");
    }
    const updated = await applyRemoteUpdate(
      env,
      identity.value,
      actor,
      {
        id: `${actorUri}/statuses/media`,
        type: "Note",
        attributedTo: actorUri,
        content: "<p>media</p>",
        published: "2026-11-01T00:00:00.000Z",
        updated: new Date(Date.now() + 1000).toISOString(),
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        attachment: [
          {
            type: "Document",
            mediaType: "video/mp4",
            url: `https://${host}/clip.mp4`,
            icon: `https://${host}/second.jpg`,
          },
        ],
      },
      { fetchSigner: unsignedFetch },
    );
    expect(updated.isOk()).toBe(true);
    const statusId = video?.id.replace(/-0$/, "") ?? "";
    const shown = expectContract(ApiStatus, (await json(`/api/v1/statuses/${statusId}`)).body);
    expect(shown.media_attachments[0]?.preview_url).toBe(`https://${host}/second.jpg`);
    expect(shown.edited_at).not.toBeNull();
  });

  it("keeps a thumbnail URL normalized, as Mastodon's Addressable normalize", async () => {
    const [video] = await persistNote("media-thumb-norm.example", [
      {
        type: "Document",
        mediaType: "video/mp4",
        url: "https://media-thumb-norm.example/clip.mp4",
        icon: "HTTPS://Media-Thumb-Norm.example/a b.jpg",
      },
    ]);
    expect(video?.preview_url).toBe("https://media-thumb-norm.example/a%20b.jpg");
    expect(video?.preview_remote_url).toBe("https://media-thumb-norm.example/a%20b.jpg");
  });

  it("ignores a thumbnail that is not an http(s) URL", async () => {
    const [video] = await persistNote("media-bad-icon.example", [
      {
        type: "Document",
        mediaType: "video/mp4",
        url: "https://media-bad-icon.example/clip.mp4",
        icon: { type: "Image", url: "javascript:alert(1)" },
      },
    ]);
    expect(video?.preview_url).toBeNull();
    expect(video?.preview_remote_url).toBeNull();
  });
});

describe("reject_media domain blocks", () => {
  it("strips stored media and drops media on later posts", async () => {
    const actorUri = "https://media-blocked.example/users/erin";
    const actor = await seedRemoteActor(actorUri, "erin", "media-blocked.example");
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("identity");
    }
    const note = (suffix: string) => ({
      id: `${actorUri}/statuses/${suffix}`,
      type: "Note" as const,
      attributedTo: actorUri,
      content: `<p>post ${suffix}</p>`,
      published: new Date().toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      attachment: [
        {
          type: "Document",
          mediaType: "image/png",
          url: `https://media-blocked.example/${suffix}.png`,
          name: "alt",
        },
      ],
    });

    expect(
      (
        await persistRemoteObject(env, identity.value, actor, note("before"), {
          fetchSigner: unsignedFetch,
        })
      ).isOk(),
    ).toBe(true);

    const blocked = await json("/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await auth("reject-media-admin@example.com")),
      },
      // `noop` keeps the domain's posts visible so only the media rule shows.
      body: JSON.stringify({
        domain: "media-blocked.example",
        severity: "noop",
        reject_media: true,
      }),
    });
    expect(blocked.status).toBe(200);

    // The already-stored post loses its media when the block is created.
    const before = await findRemoteStatusByObjectUri(env.DB, `${actorUri}/statuses/before`);
    expect(
      before.isOk() && before.value?.kind === "RemoteNote" ? before.value.media : undefined,
    ).toEqual([]);

    expect(
      (
        await persistRemoteObject(env, identity.value, actor, note("after"), {
          fetchSigner: unsignedFetch,
        })
      ).isOk(),
    ).toBe(true);

    const timeline = await json("/api/v1/timelines/public");
    const statuses = read(z.array(RemoteStatusSchema), timeline.body).filter(
      (entry) => entry.account.acct === "erin@media-blocked.example",
    );
    expect(statuses).toHaveLength(2);
    expect(statuses.flatMap((status) => status.media_attachments)).toHaveLength(0);
  });
});
