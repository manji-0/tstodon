import type { InstanceIdentity, LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { NoteMedia } from "./activitypub";
import { sensitizedAccountIds } from "./account-flag-store";
import type { RepositoryError } from "./d1";
import { mediaUrl } from "./media-document";
import { findMediaByIds } from "./media-store";

/**
 * A local note's media as its federated `attachment` lists them, in the note's
 * order, and whether an admin has sensitized its author. Only rows the author
 * attached to this note count: `mediaIds` of a draft are the request's
 * `media_ids`, which can name another account's media.
 */
export const loadNoteMedia = async (
  db: D1Database,
  identity: InstanceIdentity,
  note: LocalNote,
): Promise<Result<NoteMedia, RepositoryError>> => {
  const rows = await findMediaByIds(db, note.mediaIds);
  if (rows.isErr()) {
    return err(rows.error);
  }
  const attachments = note.mediaIds.flatMap((mediaId) => {
    const row = rows.value.get(mediaId);
    return row && row.account_id === note.accountId && row.status_id === note.id
      ? [
          {
            mediaType: row.content_type,
            url: mediaUrl(identity, row.object_key),
            name: row.description,
            focalPoint:
              row.focus_x !== null && row.focus_y !== null
                ? ([row.focus_x, row.focus_y] as const)
                : undefined,
          },
        ]
      : [];
  });
  if (attachments.length === 0) {
    return ok({ attachments, authorSensitized: false });
  }
  const sensitized = await sensitizedAccountIds(db, [note.accountId]);
  if (sensitized.isErr()) {
    return err(sensitized.error);
  }
  return ok({ attachments, authorSensitized: sensitized.value.has(note.accountId) });
};
