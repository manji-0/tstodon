import { newAttachmentObjectKey } from "./media-keys";
import {
  clearLegacyMediaKey,
  listLegacyMedia,
  rekeyLegacyMedia,
  type LegacyMedia,
} from "./media-store";

/** Rows handled per job; a full batch that made progress queues the next one. */
export const REKEY_BATCH = 50;

/** Delete the legacy object, then forget its key; true once both are done. */
const dropLegacyObject = async (
  env: Env,
  id: string,
  legacyObjectKey: string,
): Promise<boolean> => {
  await env.MEDIA.delete(legacyObjectKey);
  return (await clearLegacyMediaKey(env.DB, id, legacyObjectKey)).isOk();
};

/** Copy to a fresh key, point the row at it, then drop the legacy object. */
const moveLegacyMedia = async (
  env: Env,
  media: Extract<LegacyMedia, { kind: "Copy" }>,
): Promise<boolean> => {
  const object = await env.MEDIA.get(media.legacyObjectKey);
  if (!object) {
    // Nothing stored at the legacy key: no copy to make and nothing guessable left.
    return (await clearLegacyMediaKey(env.DB, media.id, media.legacyObjectKey)).isOk();
  }
  const objectKey = newAttachmentObjectKey(media.accountId);
  await env.MEDIA.put(objectKey, await object.arrayBuffer(), {
    httpMetadata: object.httpMetadata ?? {},
  });
  const moved = await rekeyLegacyMedia(env.DB, {
    id: media.id,
    legacyObjectKey: media.legacyObjectKey,
    objectKey,
  });
  if (moved.isErr() || !moved.value) {
    // The row is gone, another run moved it first, or D1 failed: this copy is unused.
    await env.MEDIA.delete(objectKey);
    return moved.isOk();
  }
  return dropLegacyObject(env, media.id, media.legacyObjectKey);
};

/**
 * Move one batch of attachments stored before random keys to a random key,
 * deleting each legacy object once its row points at the copy. Each row's
 * step follows from its stored keys, so a run that stopped part way is
 * finished by the next. `more` is true when rows may remain and this batch
 * made progress, so a row that keeps failing cannot chain jobs forever.
 */
export const rekeyLegacyMediaBatch = async (
  env: Env,
): Promise<Readonly<{ scanned: number; more: boolean }>> => {
  const batch = await listLegacyMedia(env.DB, REKEY_BATCH);
  if (batch.isErr()) {
    return { scanned: 0, more: false };
  }
  let progressed = 0;
  for (const media of batch.value) {
    const done =
      media.kind === "Copy"
        ? await moveLegacyMedia(env, media)
        : await dropLegacyObject(env, media.id, media.legacyObjectKey);
    if (done) progressed += 1;
  }
  return {
    scanned: batch.value.length,
    more: batch.value.length === REKEY_BATCH && progressed > 0,
  };
};
