import type { InstanceIdentity } from "@tstodon/domain";

/** R2 object-key prefixes; public URL path = key under MEDIA_PUBLIC_BASE_URL. */
export const MediaObjectKind = {
  Attachment: "attachments",
  Avatar: "avatars",
  Header: "headers",
} as const;

export type MediaObjectKind = (typeof MediaObjectKind)[keyof typeof MediaObjectKind];

export const attachmentObjectKey = (accountId: string, mediaId: string): string =>
  `${MediaObjectKind.Attachment}/${accountId}/${mediaId}`;

export const attachmentPreviewObjectKey = (accountId: string, mediaId: string): string =>
  `${MediaObjectKind.Attachment}/${accountId}/${mediaId}/preview`;

export const privateAttachmentObjectKey = (accountId: string, mediaId: string): string =>
  `private/${MediaObjectKind.Attachment}/${accountId}/${mediaId}`;

export const privateAttachmentPreviewObjectKey = (accountId: string, mediaId: string): string =>
  `private/${MediaObjectKind.Attachment}/${accountId}/${mediaId}/preview`;

export const avatarObjectKey = (accountId: string, blobId: string): string =>
  `${MediaObjectKind.Avatar}/${accountId}/${blobId}`;

export const headerObjectKey = (accountId: string, blobId: string): string =>
  `${MediaObjectKind.Header}/${accountId}/${blobId}`;

export const mediaPublicUrl = (identity: InstanceIdentity, objectKey: string): string =>
  `${identity.mediaPublicBaseUrl.replace(/\/$/, "")}/${objectKey.replace(/^\//, "")}`;

/** Worker-gated URL for private / owner-only attachments. */
export const mediaAuthUrl = (identity: InstanceIdentity, mediaId: string): string =>
  `${identity.publicOrigin.replace(/\/$/, "")}/media/${mediaId}`;

const PUBLIC_OBJECT_KEY_RE =
  /^(attachments|avatars|headers)\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+(?:\/preview)?$/;

const PRIVATE_OBJECT_KEY_RE =
  /^private\/attachments\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+(?:\/preview)?$/;

/** Reject path traversal; public proxy routes must not serve private/* keys. */
export const parseMediaObjectKey = (raw: string): string | undefined => {
  const key = raw.replace(/^\/+/, "");
  if (!PUBLIC_OBJECT_KEY_RE.test(key)) {
    return undefined;
  }
  return key;
};

export const isPrivateMediaObjectKey = (objectKey: string): boolean =>
  PRIVATE_OBJECT_KEY_RE.test(objectKey);
