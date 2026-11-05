import type { InstanceIdentity } from "@tstodon/domain";

/** R2 object-key prefixes; public URL path = key under MEDIA_PUBLIC_BASE_URL. */
export const MediaObjectKind = {
  Attachment: "attachments",
  Avatar: "avatars",
  Header: "headers",
} as const;

export type MediaObjectKind = (typeof MediaObjectKind)[keyof typeof MediaObjectKind];

/** 128 random bits as hex; Mastodon names a stored file with `SecureRandom.hex(8)`. */
const randomObjectName = (): string =>
  [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * A fresh, unguessable key for an attachment. The public media domain serves
 * every object without auth, so the random name is what keeps an attachment
 * on a private or direct post private; it is never derived from the media id.
 */
export const newAttachmentObjectKey = (accountId: string): string =>
  `${MediaObjectKind.Attachment}/${accountId}/${randomObjectName()}`;

/** The id-derived key attachments were stored at before random names. */
export const legacyAttachmentObjectKey = (accountId: string, mediaId: string): string =>
  `${MediaObjectKind.Attachment}/${accountId}/${mediaId}`;

const RANDOM_ATTACHMENT_KEY_RE = /^attachments\/[^/]+\/[0-9a-f]{32}$/;

/** An attachment key from before random names, which the rekey job moves. */
export const isLegacyAttachmentObjectKey = (objectKey: string): boolean =>
  objectKey.startsWith(`${MediaObjectKind.Attachment}/`) &&
  !RANDOM_ATTACHMENT_KEY_RE.test(objectKey);

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
