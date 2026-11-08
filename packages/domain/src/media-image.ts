/** An image's size in pixels. */
export type ImageDimensions = Readonly<{ width: number; height: number }>;

/** One size of an image as Mastodon's `meta.original` / `meta.small` describe it. */
export type ImageMeta = Readonly<{ width: number; height: number; size: string; aspect: number }>;

/**
 * Mastodon's `small` style (`MediaAttachment::IMAGE_STYLES`): at most 230,400
 * pixels (640x360), keeping the aspect ratio and never enlarging.
 */
const SMALL_PIXELS = 230_400;

export const ImageDimensions = {
  smallPixels: SMALL_PIXELS,

  /** The largest size with the same aspect ratio that has at most `pixels` pixels. */
  fitWithin: (dimensions: ImageDimensions, pixels: number): ImageDimensions => {
    const { width, height } = dimensions;
    if (width * height <= pixels) {
      return { width, height };
    }
    const scale = Math.sqrt(pixels / (width * height));
    return {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    };
  },

  /** `{ width, height, size: "WxH", aspect }`, as Mastodon's `meta` lists each size. */
  meta: (dimensions: ImageDimensions): ImageMeta => ({
    width: dimensions.width,
    height: dimensions.height,
    size: `${dimensions.width}x${dimensions.height}`,
    aspect: dimensions.width / dimensions.height,
  }),
} as const;

/** The `small` preview built from an uploaded image, not stored yet. */
export type ImagePreview = Readonly<{
  bytes: Uint8Array;
  contentType: string;
  dimensions: ImageDimensions;
}>;

/**
 * What processing an uploaded image found: its dimensions, a preview, and the
 * preview's blurhash (`null` when only the blurhash failed). `NotAnalyzed`
 * when nothing could be read, which leaves the upload as it was before
 * processing existed.
 */
export type ImageAnalysis =
  | Readonly<{
      kind: "Analyzed";
      original: ImageDimensions;
      preview: ImagePreview;
      blurhash: string | null;
    }>
  | Readonly<{ kind: "NotAnalyzed"; reason: string }>;

/** Read an uploaded image's dimensions, build its preview and blurhash. Never rejects. */
export type AnalyzeImage = (bytes: Uint8Array) => Promise<ImageAnalysis>;
