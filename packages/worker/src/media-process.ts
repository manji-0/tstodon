import { encode as encodeBlurhash } from "blurhash";
import jpeg from "jpeg-js";

export type MediaImageMeta = {
  original?: { width: number; height: number; size: number };
  small?: { width: number; height: number; size: number };
};

export type ProcessedMediaImage = {
  meta: MediaImageMeta;
  previewBytes: ArrayBuffer | null;
  previewContentType: string | null;
  /** Mastodon blurhash; null when pixel decode is unavailable in this runtime. */
  blurhash: string | null;
};

const PREVIEW_MAX_WIDTH = 640;
const BLURHASH_SAMPLE_WIDTH = 32;
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;

const encodeBlurhashFromJpeg = (jpegBytes: ArrayBuffer): string | null => {
  try {
    const decoded = jpeg.decode(new Uint8Array(jpegBytes), { useTArray: true });
    if (!decoded.width || !decoded.height || decoded.data.length === 0) {
      return null;
    }
    return encodeBlurhash(
      new Uint8ClampedArray(decoded.data),
      decoded.width,
      decoded.height,
      BLURHASH_COMPONENTS_X,
      BLURHASH_COMPONENTS_Y,
    );
  } catch {
    return null;
  }
};

/**
 * Use Cloudflare Images to read dimensions, build a WebP preview, and sample a
 * blurhash (via a tiny JPEG downsample + jpeg-js). Falls back quietly when the
 * binding is unavailable (local/miniflare gaps).
 */
export const processUploadedImage = async (
  images: ImagesBinding,
  bytes: ArrayBuffer,
): Promise<ProcessedMediaImage> => {
  const empty: ProcessedMediaImage = {
    meta: {},
    previewBytes: null,
    previewContentType: null,
    blurhash: null,
  };
  try {
    const info = await images.info(new Blob([bytes]).stream());
    if (!("width" in info) || !("height" in info)) {
      return empty;
    }
    const original = {
      width: info.width,
      height: info.height,
      size: "fileSize" in info ? info.fileSize : bytes.byteLength,
    };
    const transformed = await images
      .input(new Blob([bytes]).stream())
      .transform({ width: PREVIEW_MAX_WIDTH, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80 });
    const previewBytes = await new Response(transformed.image()).arrayBuffer();
    const scale = Math.min(1, PREVIEW_MAX_WIDTH / Math.max(original.width, 1));
    const small = {
      width: Math.max(1, Math.round(original.width * scale)),
      height: Math.max(1, Math.round(original.height * scale)),
      size: previewBytes.byteLength,
    };
    let blurhash: string | null = null;
    try {
      const sample = await images
        .input(new Blob([bytes]).stream())
        .transform({ width: BLURHASH_SAMPLE_WIDTH, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 40 });
      const sampleBytes = await new Response(sample.image()).arrayBuffer();
      blurhash = encodeBlurhashFromJpeg(sampleBytes);
    } catch {
      blurhash = null;
    }
    return {
      meta: { original, small },
      previewBytes,
      previewContentType: "image/webp",
      blurhash,
    };
  } catch {
    return empty;
  }
};
