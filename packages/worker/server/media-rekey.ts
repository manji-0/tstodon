import { newAttachmentObjectKey } from "./media-keys";
import {
  clearLegacyMediaKey,
  listLegacyMedia,
  rekeyLegacyMedia,
  rewriteEditedMediaKey,
  type LegacyMedia,
} from "./media-store";
import type { LegacyMediaPolicy } from "./runtime-config";

/** Rows handled per job; a full batch queues the job for the rows after it. */
export const REKEY_BATCH = 50;

type KeptMedia = Extract<LegacyMedia, { kind: "LegacyKept" }>;

const logNotRekeyed = (mediaId: string, reason: string): void => {
  console.error(JSON.stringify({ kind: "LegacyMediaNotRekeyed", mediaId, reason }));
};

/**
 * Copy the object to a fresh key and point the row, and its status's edit
 * history, at the copy. Returns the row's new state when a legacy object is
 * left to settle.
 */
const copyToRandomKey = async (
  env: Env,
  media: Extract<LegacyMedia, { kind: "AtLegacyKey" }>,
): Promise<KeptMedia | undefined> => {
  const object = await env.MEDIA.get(media.legacyObjectKey);
  const objectKey = newAttachmentObjectKey(media.accountId);
  if (object) {
    await env.MEDIA.put(objectKey, object.body, {
      httpMetadata: object.httpMetadata ?? {},
      customMetadata: object.customMetadata ?? {},
    });
  }
  const moved = await rekeyLegacyMedia(env.DB, {
    id: media.id,
    legacyObjectKey: media.legacyObjectKey,
    objectKey,
    legacyStored: object !== null,
  });
  if (moved.isErr()) {
    // D1 may have applied the update before failing, so the row may point at
    // the copy: keep it. At worst it is an unused object at a random key.
    logNotRekeyed(media.id, "RekeyNotConfirmed");
    return undefined;
  }
  if (!moved.value) {
    // The row is gone or another run moved it first: this copy is unused.
    if (object) await env.MEDIA.delete(objectKey);
    return undefined;
  }
  return object
    ? { kind: "LegacyKept", id: media.id, objectKey, legacyObjectKey: media.legacyObjectKey }
    : undefined;
};

/** Delete the legacy object once the row's own object is confirmed stored, then forget its key. */
const deleteLegacyObject = async (env: Env, media: KeptMedia): Promise<void> => {
  if (!(await env.MEDIA.head(media.objectKey))) {
    logNotRekeyed(media.id, "CurrentObjectMissing");
    return;
  }
  const rewritten = await rewriteEditedMediaKey(env.DB, media);
  if (rewritten.isErr()) {
    logNotRekeyed(media.id, "EditHistoryNotRewritten");
    return;
  }
  await env.MEDIA.delete(media.legacyObjectKey);
  const cleared = await clearLegacyMediaKey(env.DB, media.id, media.legacyObjectKey);
  if (cleared.isErr()) {
    logNotRekeyed(media.id, "LegacyKeyNotCleared");
  }
};

const settleKept = async (env: Env, policy: LegacyMediaPolicy, media: KeptMedia): Promise<void> => {
  switch (policy.kind) {
    case "KeepLegacy":
      return;
    case "DeleteLegacy":
      return deleteLegacyObject(env, media);
  }
};

/**
 * Move one batch of attachments stored before random keys, after `afterId`,
 * to a random key, and settle the legacy objects as `policy` says. Each row's
 * step follows from its stored keys, so a run that stopped part way is
 * finished by the next. A row that fails is logged and left for the next
 * hourly run, which starts again from the first row. `nextAfterId` is set
 * when the batch was full.
 */
export const rekeyLegacyMediaBatch = async (
  env: Env,
  policy: LegacyMediaPolicy,
  afterId: string,
): Promise<Readonly<{ scanned: number; nextAfterId: string | undefined }>> => {
  const batch = await listLegacyMedia(env.DB, policy, afterId, REKEY_BATCH);
  if (batch.isErr()) {
    return { scanned: 0, nextAfterId: undefined };
  }
  for (const media of batch.value) {
    try {
      const kept = media.kind === "AtLegacyKey" ? await copyToRandomKey(env, media) : media;
      if (kept) await settleKept(env, policy, kept);
    } catch (error) {
      logNotRekeyed(media.id, error instanceof Error ? error.message : "UnknownError");
    }
  }
  return {
    scanned: batch.value.length,
    nextAfterId: batch.value.length === REKEY_BATCH ? batch.value.at(-1)?.id : undefined,
  };
};
