import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import type { RepositoryError } from "./d1";
import {
  attachmentObjectKey,
  attachmentPreviewObjectKey,
  isPrivateMediaObjectKey,
  privateAttachmentObjectKey,
  privateAttachmentPreviewObjectKey,
} from "./media-keys";
import { findMediaById, updateMediaStorage, type MediaRow } from "./media-store";

const copyBetweenBuckets = async (
  from: R2Bucket,
  to: R2Bucket,
  fromKey: string,
  toKey: string,
): Promise<boolean> => {
  const object = await from.get(fromKey);
  if (!object) {
    return false;
  }
  const options: R2PutOptions = {};
  if (object.httpMetadata) {
    options.httpMetadata = object.httpMetadata;
  }
  if (object.customMetadata) {
    options.customMetadata = object.customMetadata;
  }
  await to.put(toKey, object.body, options);
  await from.delete(fromKey);
  return true;
};

/**
 * After attaching media to a Public/Unlisted status, move bytes from MEDIA_PRIVATE
 * onto the public MEDIA bucket (and public object keys) so MEDIA_PUBLIC_BASE_URL
 * can serve them without exposing the private bucket.
 */
export const promoteMediaToPublic = async (
  db: D1Database,
  publicBucket: R2Bucket,
  privateBucket: R2Bucket,
  accountId: string,
  mediaIds: ReadonlyArray<string>,
): Promise<Result<void, RepositoryError>> => {
  for (const mediaId of mediaIds) {
    const found = await findMediaById(db, mediaId);
    if (found.isErr()) {
      return err(found.error);
    }
    const row = found.value;
    if (!row || row.account_id !== accountId) {
      continue;
    }
    if (!isPrivateMediaObjectKey(row.object_key)) {
      const updated = await updateMediaStorage(db, {
        accountId,
        mediaId,
        objectKey: row.object_key,
        previewObjectKey: row.preview_object_key,
        isPrivate: false,
      });
      if (updated.isErr()) {
        return err(updated.error);
      }
      continue;
    }
    const publicKey = attachmentObjectKey(accountId, mediaId);
    const moved = await copyBetweenBuckets(
      privateBucket,
      publicBucket,
      row.object_key,
      publicKey,
    );
    if (!moved) {
      return err({ kind: "RepositoryError", message: `missing private media object ${mediaId}` });
    }
    let publicPreview: string | null = null;
    if (row.preview_object_key && isPrivateMediaObjectKey(row.preview_object_key)) {
      publicPreview = attachmentPreviewObjectKey(accountId, mediaId);
      await copyBetweenBuckets(
        privateBucket,
        publicBucket,
        row.preview_object_key,
        publicPreview,
      );
    } else if (row.preview_object_key) {
      publicPreview = row.preview_object_key;
    }
    const updated = await updateMediaStorage(db, {
      accountId,
      mediaId,
      objectKey: publicKey,
      previewObjectKey: publicPreview,
      isPrivate: false,
    });
    if (updated.isErr()) {
      return err(updated.error);
    }
  }
  return ok(undefined);
};

export const privateKeysForUpload = (
  accountId: string,
  mediaId: string,
): { objectKey: string; previewObjectKey: string } => ({
  objectKey: privateAttachmentObjectKey(accountId, mediaId),
  previewObjectKey: privateAttachmentPreviewObjectKey(accountId, mediaId),
});

export const mediaIsPrivate = (row: MediaRow): boolean => row.is_private === 1;

/** Bucket that holds the object for this row (private vs public). */
export const mediaBucketForRow = (env: Env, row: MediaRow): R2Bucket =>
  mediaIsPrivate(row) || isPrivateMediaObjectKey(row.object_key) ? env.MEDIA_PRIVATE : env.MEDIA;
