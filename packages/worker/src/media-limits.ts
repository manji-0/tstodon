/** Matches GET /api/v2/instance configuration.media_attachments.supported_mime_types. */
export const SUPPORTED_MEDIA_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type SupportedMediaMime = (typeof SUPPORTED_MEDIA_MIME_TYPES)[number];

/** Soft Mastodon-like image upload cap (bytes). */
export const MAX_MEDIA_UPLOAD_BYTES = 8 * 1024 * 1024;

export type MediaValidationError = {
  kind: "ValidationError";
  message: string;
};

export const validateMediaUpload = (
  contentType: string,
  byteLength: number,
): MediaValidationError | undefined => {
  if (
    !(SUPPORTED_MEDIA_MIME_TYPES as ReadonlyArray<string>).includes(contentType) &&
    contentType !== "image/jpg"
  ) {
    return {
      kind: "ValidationError",
      message: `unsupported media type: ${contentType || "(empty)"}`,
    };
  }
  if (byteLength <= 0) {
    return { kind: "ValidationError", message: "empty file" };
  }
  if (byteLength > MAX_MEDIA_UPLOAD_BYTES) {
    return {
      kind: "ValidationError",
      message: `file exceeds ${MAX_MEDIA_UPLOAD_BYTES} bytes`,
    };
  }
  return undefined;
};

export const normalizeMediaContentType = (contentType: string): string =>
  contentType === "image/jpg" ? "image/jpeg" : contentType;
