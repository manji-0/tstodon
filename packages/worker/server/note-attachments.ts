import type { InstanceIdentity, LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { NoteMedia } from "./activitypub";
import { sensitizedAccountIds } from "./account-flag-store";
import type { RepositoryError } from "./d1";
import { mediaOriginalDimensions, mediaUrl } from "./media-document";
import { findMediaByIds, type MediaRow } from "./media-store";

/** The note's attachments among `rows`, in the note's order: only rows the author attached to it. */
const noteAttachments = (
  identity: InstanceIdentity,
  note: LocalNote,
  rows: ReadonlyMap<string, MediaRow>,
): NoteMedia["attachments"] =>
  note.mediaIds.flatMap((mediaId) => {
    const row = rows.get(mediaId);
    return row && row.account_id === note.accountId && row.status_id === note.id
      ? [
          {
            mediaType: row.content_type,
            url: mediaUrl(identity, row.object_key),
            name: row.description,
            blurhash: row.blurhash,
            dimensions: mediaOriginalDimensions(row),
            focalPoint:
              row.focus_x !== null && row.focus_y !== null
                ? ([row.focus_x, row.focus_y] as const)
                : undefined,
          },
        ]
      : [];
  });

/**
 * A local note's media as its federated `attachment` lists them, in the note's
 * order, and whether an admin has sensitized its author. Only rows the author
 * attached to this note count.
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
  const attachments = noteAttachments(identity, note, rows.value);
  if (attachments.length === 0) {
    return ok({ attachments, authorSensitized: false });
  }
  const sensitized = await sensitizedAccountIds(db, [note.accountId]);
  if (sensitized.isErr()) {
    return err(sensitized.error);
  }
  return ok({ attachments, authorSensitized: sensitized.value.has(note.accountId) });
};

/** {@link loadNoteMedia} for several notes, keyed by note id, in two statements. */
export const loadNotesMedia = async (
  db: D1Database,
  identity: InstanceIdentity,
  notes: ReadonlyArray<LocalNote>,
): Promise<Result<ReadonlyMap<string, NoteMedia>, RepositoryError>> => {
  const rows = await findMediaByIds(
    db,
    notes.flatMap((note) => note.mediaIds),
  );
  if (rows.isErr()) {
    return err(rows.error);
  }
  const attachments = notes.map(
    (note) => [note, noteAttachments(identity, note, rows.value)] as const,
  );
  const sensitized = await sensitizedAccountIds(
    db,
    attachments.flatMap(([note, media]) => (media.length > 0 ? [note.accountId] : [])),
  );
  if (sensitized.isErr()) {
    return err(sensitized.error);
  }
  return ok(
    new Map(
      attachments.map(([note, media]) => [
        note.id,
        {
          attachments: media,
          authorSensitized: media.length > 0 && sensitized.value.has(note.accountId),
        },
      ]),
    ),
  );
};
