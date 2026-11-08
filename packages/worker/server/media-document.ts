import { ImageDimensions, type InstanceIdentity } from "@tstodon/domain";

import { mediaPublicUrl } from "./media-keys";
import type { MediaRow } from "./media-store";

export const mediaUrl = mediaPublicUrl;

type MediaDocumentRow = Pick<
  MediaRow,
  | "id"
  | "object_key"
  | "content_type"
  | "description"
  | "focus_x"
  | "focus_y"
  | "width"
  | "height"
  | "preview_object_key"
  | "preview_width"
  | "preview_height"
  | "blurhash"
>;

const dimensions = (width: number | null, height: number | null): ImageDimensions | undefined =>
  width !== null && height !== null && width > 0 && height > 0 ? { width, height } : undefined;

/** The original's dimensions, when the upload could read them. */
export const mediaOriginalDimensions = (
  row: Pick<MediaRow, "width" | "height">,
): ImageDimensions | undefined => dimensions(row.width, row.height);

/**
 * A local attachment as Mastodon's REST `MediaAttachment`: for an image the
 * upload processed, `meta.original` / `meta.small` with each size's `width`,
 * `height`, `size` and `aspect`, the stored preview as `preview_url`, and its
 * `blurhash`. Media without them (video, GIF, an upload the IMAGES binding
 * could not process) has the original as `preview_url` and no sizes.
 */
export const mastodonMedia = (
  identity: InstanceIdentity,
  row: MediaDocumentRow,
): Record<string, unknown> => {
  const url = mediaUrl(identity, row.object_key);
  const focus =
    row.focus_x !== null && row.focus_y !== null ? { x: row.focus_x, y: row.focus_y } : undefined;
  const original = mediaOriginalDimensions(row);
  const small =
    row.preview_object_key === null ? undefined : dimensions(row.preview_width, row.preview_height);
  return {
    id: row.id,
    type: row.content_type.startsWith("video/") ? "video" : "image",
    url,
    preview_url:
      small && row.preview_object_key !== null ? mediaUrl(identity, row.preview_object_key) : url,
    remote_url: null,
    text_url: url,
    meta: {
      ...(original ? { original: ImageDimensions.meta(original) } : {}),
      ...(small ? { small: ImageDimensions.meta(small) } : {}),
      ...(focus ? { focus } : {}),
    },
    description: row.description,
    blurhash: row.blurhash,
  };
};
