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

export const avatarObjectKey = (accountId: string, blobId: string): string =>
  `${MediaObjectKind.Avatar}/${accountId}/${blobId}`;

export const headerObjectKey = (accountId: string, blobId: string): string =>
  `${MediaObjectKind.Header}/${accountId}/${blobId}`;

export const mediaPublicUrl = (identity: InstanceIdentity, objectKey: string): string =>
  `${identity.mediaPublicBaseUrl.replace(/\/$/, "")}/${objectKey.replace(/^\//, "")}`;

const OBJECT_KEY_RE = /^(attachments|avatars|headers)\/[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+$/;

/** Reject path traversal and unexpected key shapes before R2.get. */
export const parseMediaObjectKey = (raw: string): string | undefined => {
  const key = raw.replace(/^\/+/, "");
  if (!OBJECT_KEY_RE.test(key)) {
    return undefined;
  }
  return key;
};
