import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { RemoteActor, IsoInstant } from "@tstodon/domain";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { upsertRemoteActor } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";

const json = async (path: string): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`);
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
  preview_url: z.string().min(1),
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
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    throw new Error("clock");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username,
    domain,
    inboxUri: `${actorUri}/inbox`,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: username,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("actor fixture rejected");
  }
  const stored = await upsertRemoteActor(env.DB, actor.value);
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

    const persisted = await persistRemoteObject(env.DB, identity.value, actor, {
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
    });
    expect(persisted.isOk()).toBe(true);
    expect(persisted.value).toBeDefined();

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

    const persisted = await persistRemoteObject(env.DB, identity.value, actor, {
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
    });
    expect(persisted.isOk()).toBe(true);
    expect(persisted.value?.kind === "RemoteNote" ? persisted.value.media.length : 0).toBe(4);
  });
});
