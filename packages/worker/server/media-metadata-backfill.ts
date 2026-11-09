import {
  StoredMediaMetadata,
  type ListUnstrippedMedia,
  type MarkStoredMedia,
  type ReadStoredMedia,
  type StoredMediaCursor,
  type StoredMediaLimits,
  type StoredMediaPass,
  type StoredMediaTally,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import {
  listUnstrippedAvatars as listUnstrippedAvatarsSql,
  listUnstrippedHeaders as listUnstrippedHeadersSql,
  listUnstrippedMedia as listUnstrippedMediaSql,
  markAvatarMetadataStripped as markAvatarMetadataStrippedSql,
  markHeaderMetadataStripped as markHeaderMetadataStrippedSql,
  markMediaMetadataStripped as markMediaMetadataStrippedSql,
} from "./generated/prisma/sql";
import { mediaPublicUrl } from "./media-keys";
import { parseInstanceIdentity } from "./runtime-config";
import { queryTyped, runTyped } from "./typed-sql";

const AttachmentRow = z.object({
  id: z.string().min(1),
  object_key: z.string().min(1),
  legacy_object_key: z.string().min(1).nullable(),
});

const ProfileImageRow = z.object({
  account_id: z.string().min(1),
  object_key: z.string().min(1),
});

/** The D1 pages of rows whose objects are not known to be free of metadata. */
const listUnstrippedMedia =
  (db: D1Database): ListUnstrippedMedia =>
  (source, afterId, limit) =>
    runD1(async () => {
      switch (source) {
        case "attachments":
          return (await queryTyped(db, listUnstrippedMediaSql(afterId, limit), AttachmentRow)).map(
            (row) => ({
              id: row.id,
              // The rekey job may keep the id-derived copy, which is still served.
              objectKeys:
                row.legacy_object_key === null
                  ? [row.object_key]
                  : [row.object_key, row.legacy_object_key],
            }),
          );
        case "avatars":
          return (
            await queryTyped(db, listUnstrippedAvatarsSql(afterId, limit), ProfileImageRow)
          ).map((row) => ({ id: row.account_id, objectKeys: [row.object_key] }));
        case "headers":
          return (
            await queryTyped(db, listUnstrippedHeadersSql(afterId, limit), ProfileImageRow)
          ).map((row) => ({ id: row.account_id, objectKeys: [row.object_key] }));
      }
    });

/** The mark, with the size of the object now stored at the key (a rewrite changes it). */
const markStoredMedia =
  (db: D1Database): MarkStoredMedia =>
  (source, media, mark, size) =>
    runD1(async () => {
      const objectKey = media.objectKeys[0] ?? "";
      const error = mark.kind === "Clean" ? null : mark.reason;
      const at = nowIso();
      const statement =
        source === "attachments"
          ? markMediaMetadataStrippedSql(media.id, objectKey, at, error, size)
          : source === "avatars"
            ? markAvatarMetadataStrippedSql(media.id, objectKey, at, error, size)
            : markHeaderMetadataStrippedSql(media.id, objectKey, at, error, size);
      await runTyped(db, statement);
    });

/**
 * Drop this data centre's Cache API copy of the object's URL, which the
 * Worker answers when `MEDIA_PUBLIC_BASE_URL` is its own origin. Other data
 * centres, an R2 custom domain's cache and browsers keep the old bytes until
 * they expire (see "Stripping metadata from stored media" in `docs/operations/cloudflare-deploy.md`).
 */
const dropCachedCopy = async (env: Env, objectKey: string): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  try {
    await caches.default.delete(new Request(mediaPublicUrl(identity.value, objectKey)));
  } catch {
    // Best effort: the cached copy expires on its own.
  }
};

/**
 * Read a stored object from `MEDIA` for stripping. The rewrite goes to the
 * same key only if the object is still the one read (its etag), with the
 * object's content type and custom metadata.
 */
const readStoredMedia =
  (env: Env): ReadStoredMedia =>
  async (objectKey, maxBytes) => {
    const object = await env.MEDIA.get(objectKey);
    if (!object) {
      return { kind: "Missing" };
    }
    if (object.size > maxBytes) {
      await object.body.cancel();
      return { kind: "TooLarge", size: object.size };
    }
    return {
      kind: "Found",
      bytes: new Uint8Array(await object.arrayBuffer()),
      replace: async (bytes) => {
        const written = await env.MEDIA.put(objectKey, bytes, {
          httpMetadata: object.httpMetadata ?? {},
          customMetadata: object.customMetadata ?? {},
          onlyIf: { etagMatches: object.etag },
        });
        if (written === null) {
          return false;
        }
        await dropCachedCopy(env, objectKey);
        return true;
      },
    };
  };

const logReports = (pass: StoredMediaPass): void => {
  for (const report of pass.reports) {
    const line = JSON.stringify({ kind: "MediaMetadataNotStripped", ...report });
    if (report.outcome.kind === "Missing") {
      console.warn(line);
    } else {
      console.error(line);
    }
  }
};

/**
 * One page of `StripStoredMediaMetadata`: strip the metadata from the next
 * stored originals, avatars and headers in place and mark their rows.
 */
export const stripStoredMediaMetadataPage = async (
  env: Env,
  cursor: StoredMediaCursor,
  limits: StoredMediaLimits = StoredMediaMetadata.limits,
): Promise<Result<StoredMediaPass, RepositoryError>> => {
  const pass = await StoredMediaMetadata.pass(
    {
      list: listUnstrippedMedia(env.DB),
      read: readStoredMedia(env),
      mark: markStoredMedia(env.DB),
    },
    cursor,
    limits,
  );
  if (pass.isOk()) {
    logReports(pass.value);
  }
  return pass;
};

/** The log line of the last page: what the whole run did. */
export const logStripStoredMediaMetadataDone = (tally: StoredMediaTally): void => {
  console.log(JSON.stringify({ kind: "MediaMetadataBackfillDone", ...tally }));
};
