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

/**
 * Use Cloudflare Images to read dimensions and build a WebP preview.
 * Falls back quietly when the binding is unavailable (local/miniflare gaps).
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
    return {
      meta: { original, small },
      previewBytes,
      previewContentType: "image/webp",
      blurhash: null,
    };
  } catch {
    return empty;
  }
};
