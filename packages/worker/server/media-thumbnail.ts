import { InstanceLimits } from "@tstodon/core";
import { UploadMetadata } from "@tstodon/domain";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { imagesBindingAnalyzer, processUploadedImage } from "./media-image";
import { humanSize } from "./media-limits";
import type { StoredThumbnail } from "./media-store";

/**
 * The types a thumbnail may have: Mastodon's `IMAGE_MIME_TYPES` on `main`,
 * the ones the web UI's thumbnail picker offers (HEIC, HEIF and AVIF are off
 * there, upstream's 4b5f1ba33).
 */
const THUMBNAIL_TYPES: ReadonlyArray<string> = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export type ThumbnailError = Readonly<
  | { kind: "ThumbnailNotAllowed" }
  | { kind: "ThumbnailInvalid" }
  | { kind: "ThumbnailTooLarge" }
  | { kind: "ThumbnailNotProcessed" }
>;

/** Mastodon's `validates :thumbnail, absence: true` unless the attachment is audio or video. */
export const thumbnailAllowed = (contentType: string): boolean =>
  contentType.startsWith("video/") || contentType.startsWith("audio/");

/**
 * Store `file` as a thumbnail, as Mastodon's `THUMBNAIL_STYLES` keeps one:
 * resized to the `small` size, with its blurhash. The file is checked
 * against the types and the image size limit first, stripped of its
 * metadata, and nothing is stored when it cannot be processed.
 */
export const storeThumbnail = async (
  env: Env,
  accountId: string,
  file: File,
): Promise<Result<StoredThumbnail, ThumbnailError>> => {
  const contentType = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!THUMBNAIL_TYPES.includes(contentType)) {
    return err({ kind: "ThumbnailInvalid" });
  }
  if (file.size > InstanceLimits.media.imageSizeLimit) {
    return err({ kind: "ThumbnailTooLarge" });
  }
  const scrubbed = UploadMetadata.forUpload(contentType, new Uint8Array(await file.arrayBuffer()));
  if (scrubbed.isErr()) {
    return err({ kind: "ThumbnailInvalid" });
  }
  const image = await processUploadedImage(
    env.MEDIA,
    imagesBindingAnalyzer(env.IMAGES),
    accountId,
    scrubbed.value,
  );
  return image?.preview
    ? ok({ ...image.preview, blurhash: image.blurhash })
    : err({ kind: "ThumbnailNotProcessed" });
};

/** Mastodon's answer to each: a validation error, or its `processing_error`. */
export const jsonThumbnailError = (c: Context<{ Bindings: Env }>, error: ThumbnailError) => {
  switch (error.kind) {
    case "ThumbnailNotAllowed":
      return c.json(
        { error: "Validation failed: Thumbnail must be blank", kind: "ValidationError" },
        422,
      );
    case "ThumbnailInvalid":
      return c.json(
        {
          error: "Validation failed: Thumbnail content type is invalid, Thumbnail is invalid",
          kind: "ValidationError",
        },
        422,
      );
    case "ThumbnailTooLarge":
      return c.json(
        {
          error: `Validation failed: Thumbnail file size must be less than ${humanSize(InstanceLimits.media.imageSizeLimit)}`,
          kind: "ValidationError",
        },
        422,
      );
    case "ThumbnailNotProcessed":
      return c.json({ error: "Error processing thumbnail for uploaded media" }, 500);
  }
};
