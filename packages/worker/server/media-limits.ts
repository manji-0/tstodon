import { InstanceLimits } from "@tstodon/core";
import { MediaDimensions } from "@tstodon/domain";

/**
 * Rails' `number_to_human_size`, as Paperclip's size message prints a limit:
 * binary units, three significant digits, no trailing zeros ("16 MB").
 */
export const humanSize = (bytes: number): string => {
  const units = ["Bytes", "KB", "MB", "GB", "TB"] as const;
  let exponent = 0;
  while (exponent < units.length - 1 && bytes >= 1024 ** (exponent + 1)) {
    exponent += 1;
  }
  if (exponent === 0) {
    return `${bytes} Bytes`;
  }
  return `${Number((bytes / 1024 ** exponent).toPrecision(3))} ${units[exponent]}`;
};

/** The advertised size limit for an upload of this (supported) type. */
export const uploadSizeLimit = (contentType: string): number =>
  contentType.startsWith("video/")
    ? InstanceLimits.media.videoSizeLimit
    : InstanceLimits.media.imageSizeLimit;

/**
 * Why an upload breaks the advertised `image_size_limit` /
 * `video_size_limit`, as Mastodon's 422 message (Paperclip's
 * `validates_attachment_size`), or `undefined` when it is within them.
 */
export const uploadSizeViolation = (contentType: string, size: number): string | undefined => {
  const limit = uploadSizeLimit(contentType);
  return size > limit
    ? `Validation failed: File file size must be less than ${humanSize(limit)}`
    : undefined;
};

/**
 * Why an upload breaks the advertised `image_matrix_limit` /
 * `video_matrix_limit` (`Mastodon::DimensionsValidationError`) or
 * `video_frame_rate_limit` (`Mastodon::StreamValidationError`), as
 * Mastodon's 422 message, or `undefined` when it keeps them. Dimensions come
 * from the header; a file whose header does not say is let through, as
 * Mastodon does.
 */
export const uploadDimensionViolation = (
  contentType: string,
  bytes: Uint8Array,
): string | undefined => {
  if (contentType.startsWith("video/")) {
    const video = MediaDimensions.ofVideo(bytes);
    if (!video) {
      return undefined;
    }
    if (video.width * video.height > InstanceLimits.media.videoMatrixLimit) {
      return `${video.width}x${video.height} videos are not supported`;
    }
    const frameRate = video.frameRate === undefined ? undefined : Math.floor(video.frameRate);
    return frameRate !== undefined && frameRate > InstanceLimits.media.videoFrameRateLimit
      ? `${frameRate}fps videos are not supported`
      : undefined;
  }
  const image = MediaDimensions.ofImage(bytes);
  return image && image.width * image.height > InstanceLimits.media.imageMatrixLimit
    ? `${image.width}x${image.height} images are not supported`
    : undefined;
};
