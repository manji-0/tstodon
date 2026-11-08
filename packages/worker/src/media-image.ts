import { schemaResult } from "@tstodon/core";
import { type AnalyzeImage, type ImageAnalysis, ImageDimensions } from "@tstodon/domain";
import { z } from "zod";
import { encodeBlurhash } from "./blurhash";
import { newAttachmentObjectKey } from "./media-keys";
import type { StoredImage } from "./media-store";
import { decodePng } from "./png-pixels";

/** The image types the upload builds a preview for. GIF and video keep the original only. */
const ANALYZED_TYPES: ReadonlyArray<string> = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
];

export const isAnalyzedImageType = (contentType: string): boolean =>
  ANALYZED_TYPES.includes(contentType);

/** The preview's format: WebP keeps transparency at a fraction of PNG's size. */
const PREVIEW_TYPE = "image/webp";
const PREVIEW_QUALITY = 80;

/**
 * Mastodon's `BlurhashTranscoder` samples a 100-pixel thumbnail of the small
 * file and encodes 4x4 components (`BLURHASH_OPTIONS`).
 */
const BLURHASH_BOX = 100;
const BLURHASH_COMPONENTS = 4;

const BitmapInfo = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : "image processing failed";

const dimensionsOf = async (
  images: ImagesBinding,
  bytes: Uint8Array,
): Promise<ImageDimensions | undefined> => {
  const parsed = schemaResult(BitmapInfo)(await images.info(streamOf(bytes)));
  return parsed.isOk() ? parsed.value : undefined;
};

/** The blurhash of the preview, or `null` when sampling or decoding fails. */
const blurhashOf = async (images: ImagesBinding, preview: Uint8Array): Promise<string | null> => {
  try {
    const thumbnail = await images
      .input(streamOf(preview))
      .transform({ width: BLURHASH_BOX, height: BLURHASH_BOX, fit: "scale-down" })
      .output({ format: "image/png" });
    const png = new Uint8Array(await thumbnail.response().arrayBuffer());
    const decoded = await decodePng(png, BLURHASH_BOX * BLURHASH_BOX);
    return decoded
      ? encodeBlurhash(
          decoded.pixels,
          decoded.width,
          decoded.height,
          BLURHASH_COMPONENTS,
          BLURHASH_COMPONENTS,
        )
      : null;
  } catch {
    return null;
  }
};

/**
 * The original's dimensions as displayed. `info` may report a JPEG's stored
 * size before its EXIF orientation applies, while the transformed preview is
 * upright, so a preview whose orientation differs swaps them.
 */
const uprightOriginal = (original: ImageDimensions, preview: ImageDimensions): ImageDimensions =>
  preview.width !== preview.height &&
  original.width !== original.height &&
  preview.width > preview.height !== original.width > original.height
    ? { width: original.height, height: original.width }
    : original;

/**
 * `AnalyzeImage` over the Workers Images binding: `info` for the original's
 * dimensions, a WebP within Mastodon's `small` pixel budget, and a blurhash
 * from a PNG thumbnail of that preview. Without a binding, or when any step
 * but the blurhash fails, the upload goes on unanalyzed.
 */
export const imagesBindingAnalyzer =
  (images: ImagesBinding | undefined): AnalyzeImage =>
  async (bytes): Promise<ImageAnalysis> => {
    if (!images) {
      return { kind: "NotAnalyzed", reason: "no IMAGES binding" };
    }
    try {
      const stored = await dimensionsOf(images, bytes);
      if (!stored) {
        return { kind: "NotAnalyzed", reason: "not a bitmap image" };
      }
      const target = ImageDimensions.fitWithin(stored, ImageDimensions.smallPixels);
      const output = await images
        .input(streamOf(bytes))
        .transform({ width: target.width, height: target.height, fit: "scale-down" })
        .output({ format: PREVIEW_TYPE, quality: PREVIEW_QUALITY, anim: false });
      const previewBytes = new Uint8Array(await output.response().arrayBuffer());
      const previewDimensions = await dimensionsOf(images, previewBytes);
      if (!previewDimensions) {
        return { kind: "NotAnalyzed", reason: "preview has no dimensions" };
      }
      return {
        kind: "Analyzed",
        original: uprightOriginal(stored, previewDimensions),
        preview: {
          bytes: previewBytes,
          contentType: output.contentType() || PREVIEW_TYPE,
          dimensions: previewDimensions,
        },
        blurhash: await blurhashOf(images, previewBytes),
      };
    } catch (error) {
      return { kind: "NotAnalyzed", reason: reasonOf(error) };
    }
  };

/**
 * Analyze an uploaded image and store its preview under a fresh random key
 * next to the original (#57), for the row to record. `null` when the image
 * could not be analyzed; the upload then goes on as before processing existed.
 * A preview that fails to store leaves the dimensions and blurhash.
 */
export const processUploadedImage = async (
  media: R2Bucket,
  analyze: AnalyzeImage,
  accountId: string,
  bytes: Uint8Array,
): Promise<StoredImage | null> => {
  const analysis = await analyze(bytes).catch((error: unknown): ImageAnalysis => ({
    kind: "NotAnalyzed",
    reason: reasonOf(error),
  }));
  if (analysis.kind === "NotAnalyzed") {
    console.warn(JSON.stringify({ kind: "MediaImageNotProcessed", reason: analysis.reason }));
    return null;
  }
  const objectKey = newAttachmentObjectKey(accountId);
  const stored = await media
    .put(objectKey, analysis.preview.bytes, {
      httpMetadata: { contentType: analysis.preview.contentType },
    })
    .then(
      () => true,
      () => false,
    );
  if (!stored) {
    console.warn(JSON.stringify({ kind: "MediaPreviewNotStored" }));
  }
  return {
    original: analysis.original,
    preview: stored ? { objectKey, dimensions: analysis.preview.dimensions } : undefined,
    blurhash: analysis.blurhash,
  };
};
