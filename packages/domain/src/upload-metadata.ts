import { err, ok, type Result } from "neverthrow";
import { ImageMetadata, type MalformedImage } from "./image-metadata";
import { VideoMetadata, type MalformedVideo } from "./video-metadata";

/** Why an upload cannot be stored without its metadata. */
export type UnstrippableUpload =
  | MalformedImage
  | MalformedVideo
  | Readonly<{ kind: "NotTheDeclaredType"; contentType: string }>;

/** Declared types whose bytes must be one of the image containers stripped. */
const IMAGE_CONTAINER_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);

/** Declared types whose bytes must be one of the video containers stripped. */
const VIDEO_CONTAINER_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/webm"]);

const notTheDeclaredType = (contentType: string): Result<never, UnstrippableUpload> =>
  err({ kind: "NotTheDeclaredType", contentType });

export const UploadMetadata = {
  /**
   * The bytes to store for an upload declared as `contentType`: stripped of
   * their metadata whenever they are a known image or video container, judged
   * by the bytes, and refused when they are damaged, when a JPEG, PNG, WebP
   * or AVIF upload is not an image container, or when an MP4 or WebM upload
   * is not a video container. Anything else (GIF) passes through as uploaded.
   */
  forUpload: (contentType: string, bytes: Uint8Array): Result<Uint8Array, UnstrippableUpload> => {
    const image = ImageMetadata.strip(bytes);
    if (image.isErr()) {
      return err(image.error);
    }
    if (image.value.kind === "Stripped") {
      return VIDEO_CONTAINER_TYPES.has(contentType)
        ? notTheDeclaredType(contentType)
        : ok(image.value.bytes);
    }
    const video = VideoMetadata.strip(bytes);
    if (video.isErr()) {
      return err(video.error);
    }
    if (video.value.kind === "Stripped") {
      return IMAGE_CONTAINER_TYPES.has(contentType)
        ? notTheDeclaredType(contentType)
        : ok(video.value.bytes);
    }
    return IMAGE_CONTAINER_TYPES.has(contentType) || VIDEO_CONTAINER_TYPES.has(contentType)
      ? notTheDeclaredType(contentType)
      : ok(bytes);
  },
} as const;
