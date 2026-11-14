import { IsoInstant, type RemoteActor, type RemoteStatusValue } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { nowInstant } from "./clock";
import type { RepositoryError } from "./d1";
import { contentChanged, isNewer } from "./remote-status-edit";
import {
  applyMediaPolicy,
  noteFromUnknown,
  noteHashtags,
  parseNoteDocument,
} from "./remote-note-document";
import {
  type InvalidRemoteStatusRow,
  overwriteRemoteStatus,
  salvageRemoteStatus,
} from "./remote-status-store";

/**
 * How a note document reaches a row that does not read. `Create` and `Update`
 * are inbox activities the note's author signed. `Fetched` is the document
 * read from the note's own URI on its author's host, for another activity
 * that refers to the note.
 */
export type HealingDocument = Readonly<{ activity: "Create" | "Update" | "Fetched"; raw: unknown }>;

/** The row stays as it is and the delivery is dropped, as Mastodon drops a `RecordInvalid`. */
const kept = (
  statusId: string,
  reason: "NotTheAuthorsNote" | "DocumentNotANote" | "RowNotRewritable" | "NotNewer" | "NotDated",
): Result<undefined, RepositoryError> => {
  console.warn(JSON.stringify({ kind: "InvalidRemoteStatusRowKept", statusId, reason }));
  return ok(undefined);
};

/**
 * Settle a note document that arrives for a stored row which does not read
 * as a status. Delivering it again would find the same row, so the row is
 * never a reason to answer with an error. When `signer` wrote the note and
 * `raw` is its document, the row is replaced under the id it holds, and the
 * status it now reads as is returned: no history version, marker,
 * notification or stream event, as the row was shown to nobody. Any other
 * document is dropped, with `undefined`. Only a failed read or write is an
 * `Err`.
 *
 * The replacement starts from what the row still holds
 * ({@link salvageRemoteStatus}): every column that reads on its own counts as
 * stored, so the delivery is applied as to a stored note. A document that
 * changes the content of a note edited since is dropped, as an ordinary
 * `Update` that is not newer: a `Create` carries the note as first
 * published, and a replayed `Update` an older edit. An `Update` keeps the
 * stored visibility, publication date and language, and so does a fetched
 * document, which is the note as it reads now. A fetched document is dated
 * by its `updated` only: it is no edit, so one without a date is not dated
 * now. A new tally settles the local votes, as it does for a row that reads.
 *
 * A row whose `edited_at` does not read was edited at a time unknown, not
 * never. A document that changes its content then replaces it only when its
 * `updated` is later than the last write of the row (`updated_at`), which no
 * edit the row holds was received after: a replayed older `Update` is dated
 * before it, and so is the `Create` of a note edited since. A document
 * without `updated` does not replace it, not even an `Update`, as dating it
 * now would date its replay now too (`NotDated`). Nor does any document
 * when `updated_at` does not read either. The cost is a real edit made
 * before this server last wrote the row, or dated so by a clock that runs
 * behind: it is dropped, and the row stays until a later edit. A document
 * that changes nothing still replaces the row, and its `updated` is the date
 * of the content both hold, so it becomes the row's.
 */
export const settleInvalidRemoteStatus = async (
  env: Env,
  signer: RemoteActor,
  invalid: InvalidRemoteStatusRow,
  delivery: HealingDocument,
): Promise<Result<RemoteStatusValue | undefined, RepositoryError>> => {
  const { activity, raw } = delivery;
  const parsed = noteFromUnknown(raw, signer);
  const note = parseNoteDocument(raw);
  if (invalid.actorUri !== signer.actorUri) {
    return kept(invalid.id, "NotTheAuthorsNote");
  }
  if (parsed.isErr() || note.isErr()) {
    return kept(invalid.id, "DocumentNotANote");
  }
  const salvaged = await salvageRemoteStatus(env.DB, invalid.id, parsed.value);
  if (salvaged.isErr()) {
    return err(salvaged.error);
  }
  // The fault is in a column the replacement keeps (the id, the author, the
  // object URI), so replacing the row would leave it as unreadable as it is.
  if (salvaged.value === undefined) {
    return kept(invalid.id, "RowNotRewritable");
  }
  const stored = salvaged.value.status;
  const delivered: RemoteStatusValue =
    activity !== "Create"
      ? {
          ...parsed.value,
          publishedAt: stored.publishedAt,
          visibility: stored.visibility,
          language: stored.language,
        }
      : parsed.value;
  const refreshed = await applyMediaPolicy(env, signer, {
    ...delivered,
    id: stored.id,
    editedAt: stored.editedAt,
  });
  const dated = IsoInstant.parseRemote(note.value.updated ?? "").unwrapOr(undefined);
  // An `Update` without a date is dated now, as an ordinary one. A `Create`
  // without one is the note before any edit.
  const updated = dated ?? (activity === "Update" ? nowInstant() : undefined);
  const edited = contentChanged(stored, refreshed);
  const { edit } = salvaged.value;
  if (edited && edit.kind === "Unknown") {
    if (dated === undefined) {
      return kept(invalid.id, "NotDated");
    }
    if (edit.writtenAt === undefined || !isNewer(dated, edit.writtenAt)) {
      return kept(invalid.id, "NotNewer");
    }
  }
  if (
    edited &&
    stored.editedAt.kind === "Edited" &&
    !(updated !== undefined && isNewer(updated, stored.editedAt.at))
  ) {
    return kept(invalid.id, "NotNewer");
  }
  // The date of the content the row is left with: the document's when it
  // changes the content, or when the row has lost its own.
  const editedAt = edited ? updated : edit.kind === "Unknown" ? dated : undefined;
  const status: RemoteStatusValue =
    editedAt !== undefined
      ? { ...refreshed, editedAt: { kind: "Edited", at: editedAt } }
      : refreshed;
  const replaced = await overwriteRemoteStatus(env.DB, salvaged.value, status, noteHashtags(raw));
  if (replaced.isErr()) {
    return err(replaced.error);
  }
  console.warn(
    JSON.stringify({ kind: "InvalidRemoteStatusRowReplaced", statusId: invalid.id, activity }),
  );
  return ok(status);
};
