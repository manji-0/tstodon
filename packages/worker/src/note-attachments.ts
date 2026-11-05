import type { InstanceIdentity, LocalNote } from "@tstodon/domain";
import type { NoteAttachment } from "./activitypub";
import { mediaUrl } from "./media-document";
import { findMediaByIds } from "./media-store";

/** A local note's media as its federated `attachment` lists them, in the note's order. */
export const loadNoteAttachments = async (
  db: D1Database,
  identity: InstanceIdentity,
  note: LocalNote,
): Promise<ReadonlyArray<NoteAttachment>> => {
  const rows = await findMediaByIds(db, note.mediaIds);
  if (rows.isErr()) {
    return [];
  }
  return note.mediaIds.flatMap((mediaId) => {
    const row = rows.value.get(mediaId);
    return row
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
};
