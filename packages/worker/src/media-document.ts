import { type InstanceIdentity } from "@tstodon/domain";

export const mediaUrl = (identity: InstanceIdentity, objectKey: string): string =>
  `${identity.mediaPublicBaseUrl.replace(/\/$/, "")}/${objectKey}`;

export const mastodonMedia = (
  identity: InstanceIdentity,
  row: {
    id: string;
    object_key: string;
    content_type: string;
    description?: string | null;
    focus_x?: number | null;
    focus_y?: number | null;
  },
): Record<string, unknown> => {
  const url = mediaUrl(identity, row.object_key);
  const focus =
    row.focus_x !== null &&
    row.focus_x !== undefined &&
    row.focus_y !== null &&
    row.focus_y !== undefined
      ? { x: row.focus_x, y: row.focus_y }
      : undefined;
  return {
    id: row.id,
    type: row.content_type.startsWith("video/") ? "video" : "image",
    url,
    preview_url: url,
    remote_url: null,
    text_url: url,
    meta: focus ? { focus } : {},
    description: row.description ?? null,
    blurhash: null,
  };
};
