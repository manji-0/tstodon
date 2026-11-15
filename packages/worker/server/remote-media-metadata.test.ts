import { SELF, env } from "cloudflare:test";
import { ApiStatus, type ApiStatusJSON } from "@tstodon/api";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { parseRows } from "./d1";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/** A 4x3-component BlurHash, as Mastodon writes for every image. */
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";

const note = (
  author: Remote,
  slug: string,
  attachment: ReadonlyArray<unknown>,
  updated?: string,
) => ({
  id: `https://remote.example/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  attachment,
  ...(updated ? { updated } : {}),
});

const document = (extra: Record<string, unknown> = {}) => ({
  type: "Document",
  mediaType: "image/png",
  url: "https://remote.example/media/cat.png",
  name: "a cat",
  ...extra,
});

const statusIdOf = async (objectUri: string): Promise<string> => {
  const found = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .all();
  const id = parseRows(z.object({ id: z.string() }), found.results)[0]?.id;
  if (!id) {
    throw new Error(`remote note ${objectUri} was not stored`);
  }
  return id;
};

const deliver = async (
  author: Remote,
  type: "Create" | "Update",
  object: ReturnType<typeof note>,
): Promise<string> => {
  expect(
    await author.send({ id: `${object.id}/${type}/${object.updated ?? "first"}`, type, object }),
  ).toBe(202);
  return statusIdOf(object.id);
};

const status = async (id: string): Promise<ApiStatusJSON> => {
  const response = await SELF.fetch(`https://example.com/api/v1/statuses/${id}`);
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const attachmentOf = async (id: string) => {
  const [attachment] = (await status(id)).media_attachments;
  if (!attachment) {
    throw new Error("the status has no attachment");
  }
  return attachment;
};

describe("the metadata of a remote attachment", () => {
  it("shows the blurhash, the sizes and the focus point the note declares", async () => {
    const author = await remoteActor("media-meta");
    const id = await deliver(
      author,
      "Create",
      note(author, "meta-image", [
        document({ blurhash: BLURHASH, width: 1280, height: 720, focalPoint: [0.5, -0.25] }),
      ]),
    );
    expect(await attachmentOf(id)).toMatchObject({
      type: "image",
      blurhash: BLURHASH,
      description: "a cat",
      meta: {
        original: { width: 1280, height: 720, size: "1280x720", aspect: 1280 / 720 },
        small: { width: 640, height: 360, size: "640x360", aspect: 640 / 360 },
        focus: { x: 0.5, y: -0.25 },
      },
    });
  });

  it("gives a video its size and focus point, and an attachment without any an empty meta", async () => {
    const author = await remoteActor("media-meta-video");
    const id = await deliver(
      author,
      "Create",
      note(author, "meta-video", [
        document({
          mediaType: "video/mp4",
          url: "https://remote.example/media/clip.mp4",
          blurhash: BLURHASH,
          width: 640,
          height: 480,
          focalPoint: [0, 1],
        }),
        document({ url: "https://remote.example/media/plain.png" }),
      ]),
    );
    const [video, plain] = (await status(id)).media_attachments;
    expect(video).toMatchObject({
      type: "video",
      blurhash: BLURHASH,
      meta: { original: { width: 640, height: 480 }, focus: { x: 0, y: 1 } },
    });
    expect(plain).toMatchObject({ type: "image", blurhash: null, meta: {} });
  });

  it("leaves out a blurhash, a size and a focus point that do not read", async () => {
    const author = await remoteActor("media-meta-invalid");
    const id = await deliver(
      author,
      "Create",
      note(author, "meta-invalid", [
        // Nine by nine components: Mastodon takes five at most on each axis.
        document({
          blurhash: `|${"0".repeat(165)}`,
          width: -4,
          height: "tall",
          focalPoint: "left",
        }),
      ]),
    );
    expect(await attachmentOf(id)).toMatchObject({ blurhash: null, meta: {} });

    const clamped = await deliver(
      author,
      "Create",
      note(author, "meta-clamped", [
        document({ blurhash: "not a blurhash", width: 10, focalPoint: [3, -7] }),
      ]),
    );
    expect(await attachmentOf(clamped)).toMatchObject({
      blurhash: null,
      meta: { focus: { x: 1, y: -1 } },
    });
    expect((await attachmentOf(clamped)).meta).not.toHaveProperty("original");
  });

  it("fills a note stored without metadata from an Update, which is not an edit", async () => {
    const author = await remoteActor("media-meta-old-row");
    const id = await deliver(author, "Create", note(author, "meta-old", [document()]));
    // The row as a version before the metadata was kept wrote it.
    const stored = await env.DB.prepare("SELECT media_json FROM remote_statuses WHERE id = ?")
      .bind(id)
      .all();
    expect(parseRows(z.object({ media_json: z.string() }), stored.results)[0]?.media_json).toBe(
      JSON.stringify([
        {
          url: "https://remote.example/media/cat.png",
          mediaType: "image/png",
          description: "a cat",
        },
      ]),
    );

    await deliver(
      author,
      "Update",
      note(
        author,
        "meta-old",
        [document({ blurhash: BLURHASH, width: 64, height: 48, focalPoint: [-1, 1] })],
        "2026-10-21T00:00:00.000Z",
      ),
    );
    const refreshed = await status(id);
    expect(refreshed.edited_at).toBeNull();
    expect(refreshed.media_attachments[0]).toMatchObject({
      blurhash: BLURHASH,
      meta: { original: { width: 64, height: 48 }, focus: { x: -1, y: 1 } },
    });
    const history = await SELF.fetch(`https://example.com/api/v1/statuses/${id}/history`);
    expect(await history.json()).toHaveLength(1);
  });
});
