/** Sweep area INT-11: focus points, blurhash, sensitive media, several images in order, a video, and whether the copy's files load. */
import { A, signUp, type E2eUser } from "../lib.js";
import { mp4, png, upload } from "./media.js";
import {
  bothWays,
  type Cast,
  eventually,
  follow,
  onHome,
  post,
  skip,
  type Status,
  StepFailure,
} from "./sweep.js";

/** Fetch a media URL as a signed-in browser of `viewer`'s server would; its content type. */
const loads = async (viewer: E2eUser, url: string | null, what: string): Promise<string> => {
  if (!url) {
    throw new StepFailure(`the copy has no ${what}`);
  }
  const response = await eventually(`${what} ${url} loads`, async () => {
    const answer = await fetch(new URL(url, viewer.origin), { headers: viewer.headers });
    const bytes = (await answer.arrayBuffer()).byteLength;
    return answer.ok && bytes > 0 ? answer : undefined;
  });
  return response.headers.get("content-type") ?? "";
};

/** The copy once the receiving server has processed the attachment (Mastodon downloads it after the status arrives). */
const withMedia = (viewer: E2eUser, uri: string, accept: (status: Status) => boolean) =>
  onHome(viewer, uri, (status) => status.media_attachments.length > 0 && accept(status));

export const mediaScenarios = async ({ stamp, mona }: Cast): Promise<void> => {
  const alice = await signUp(A, "mia");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays("an image arrives with its focus point", alice, mona, async (from, to) => {
    const media = await upload(from, `focus ${stamp}`, { focus: "0.5,-0.25" });
    const sent = await post(from, { status: `focus ${stamp}`, media_ids: [media] });
    const copy = await withMedia(to, sent.uri, () => true);
    const focus = copy.media_attachments[0]?.meta?.focus;
    if (focus?.x !== 0.5 || focus.y !== -0.25) {
      throw new StepFailure(`the copy's focus is ${JSON.stringify(focus)}`);
    }
  });

  await bothWays("an image arrives with a blurhash and its size", alice, mona, async (from, to) => {
    const media = await upload(from, `blurhash ${stamp}`, { file: png([40, 160, 90], 64, 48) });
    const sent = await post(from, { status: `blurhash ${stamp}`, media_ids: [media] });
    let last = "";
    await withMedia(to, sent.uri, (status) => {
      const [attachment] = status.media_attachments;
      last = JSON.stringify({ blurhash: attachment?.blurhash, meta: attachment?.meta });
      const original = attachment?.meta?.original;
      return (
        typeof attachment?.blurhash === "string" &&
        attachment.blurhash.length >= 6 &&
        original?.width === 64 &&
        original.height === 48
      );
    }).catch((error: unknown) => {
      throw new StepFailure(
        `${error instanceof Error ? error.message : String(error)}; saw ${last}`,
      );
    });
  });

  await bothWays("the copy's image and preview load", alice, mona, async (from, to) => {
    const media = await upload(from, `loads ${stamp}`);
    const sent = await post(from, { status: `loads ${stamp}`, media_ids: [media] });
    const copy = await withMedia(to, sent.uri, () => true);
    const [attachment] = copy.media_attachments;
    for (const [what, url] of [
      ["image", attachment?.url],
      ["preview", attachment?.preview_url],
    ] as const) {
      const type = await loads(to, url ?? null, what);
      if (!type.startsWith("image/")) {
        throw new StepFailure(`the copy's ${what} is served as ${type}`);
      }
    }
  });

  await bothWays("media marked sensitive stays sensitive", alice, mona, async (from, to) => {
    const media = await upload(from, `sensitive ${stamp}`);
    const sent = await post(from, {
      status: `sensitive ${stamp}`,
      media_ids: [media],
      sensitive: true,
    });
    const copy = await withMedia(to, sent.uri, () => true);
    if (!copy.sensitive || copy.spoiler_text !== "") {
      throw new StepFailure(
        `the copy is sensitive ${String(copy.sensitive)} with the warning "${copy.spoiler_text}"`,
      );
    }
  });

  await bothWays("four images arrive in their order", alice, mona, async (from, to) => {
    const colours = [
      [220, 40, 40],
      [40, 220, 40],
      [40, 40, 220],
      [220, 220, 40],
    ] as const;
    const media: string[] = [];
    for (const [index, colour] of colours.entries()) {
      media.push(await upload(from, `image ${index} ${stamp}`, { file: png(colour) }));
    }
    const sent = await post(from, { status: `four ${stamp}`, media_ids: media });
    let last = "";
    await withMedia(to, sent.uri, (status) => {
      last = status.media_attachments.map((attachment) => attachment.description).join();
      return last === colours.map((_, index) => `image ${index} ${stamp}`).join();
    }).catch((error: unknown) => {
      throw new StepFailure(
        `${error instanceof Error ? error.message : String(error)}; saw ${last}`,
      );
    });
  });

  const video = mp4();
  if (video === undefined) {
    skip("a video arrives as a video", "no ffmpeg: Docker is not reachable from this process");
    return;
  }
  await bothWays("a video arrives as a video and loads", alice, mona, async (from, to) => {
    const media = await upload(from, `video ${stamp}`, { file: video, name: "test.mp4" });
    const sent = await post(from, { status: `video ${stamp}`, media_ids: [media] });
    const copy = await withMedia(to, sent.uri, () => true);
    const [attachment] = copy.media_attachments;
    // Mastodon calls a short video with no sound `gifv`, its own upload too.
    if (
      (attachment?.type !== "video" && attachment?.type !== "gifv") ||
      attachment.description !== `video ${stamp}`
    ) {
      throw new StepFailure(`the copy's media is ${JSON.stringify(copy.media_attachments)}`);
    }
    const type = await loads(to, attachment.url, "video");
    if (!type.startsWith("video/")) {
      throw new StepFailure(`the copy's video is served as ${type}`);
    }
  });
};
