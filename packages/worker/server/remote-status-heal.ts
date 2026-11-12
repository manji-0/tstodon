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
} from "./remote-status-persist";
import {
  type InvalidRemoteStatusRow,
  overwriteRemoteStatus,
  salvageRemoteStatus,
} from "./remote-status-store";

/** The row stays as it is and the delivery is dropped, as Mastodon drops a `RecordInvalid`. */
const kept = (
  statusId: string,
  reason: "NotTheAuthorsNote" | "DocumentNotANote" | "RowNotRewritable" | "NotNewer",
): Result<void, RepositoryError> => {
  console.warn(JSON.stringify({ kind: "InvalidRemoteStatusRowKept", statusId, reason }));
  return ok(undefined);
};

/**
 * Settle a `Create` or `Update` of a note whose stored row does not read as a
 * status. Delivering it again would find the same row, so the row is never a
 * reason to answer with an error. When `signer` wrote the note and `raw` is
 * its document, the row is replaced under the id it holds: no history
 * version, notification or stream event, as the row was shown to nobody. Any
 * other delivery is dropped. Only a failed read or write is an `Err`.
 *
 * The replacement starts from what the row still holds
 * ({@link salvageRemoteStatus}): every column that reads on its own counts as
 * stored, so the delivery is applied as to a stored note. A document that
 * changes the content of a note edited since is dropped, as an ordinary
 * `Update` that is not newer: a `Create` carries the note as first
 * published, and a replayed `Update` an older edit. An `Update` keeps the
 * stored visibility, publication date and language. A new tally settles the
 * local votes, as it does for a row that reads.
 */
export const settleInvalidRemoteStatus = async (
  env: Env,
  signer: RemoteActor,
  invalid: InvalidRemoteStatusRow,
  delivery: Readonly<{ activity: "Create" | "Update"; raw: unknown }>,
): Promise<Result<void, RepositoryError>> => {
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
  const stored = salvaged.value;
  const delivered: RemoteStatusValue =
    activity === "Update"
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
  // An `Update` without a date is dated now, as an ordinary one. A `Create`
  // without one is the note before any edit.
  const updated = IsoInstant.parseRemote(note.value.updated ?? "").unwrapOr(
    activity === "Update" ? nowInstant() : undefined,
  );
  const edited = contentChanged(stored, refreshed);
  if (
    edited &&
    stored.editedAt.kind === "Edited" &&
    !(updated !== undefined && isNewer(updated, stored.editedAt.at))
  ) {
    return kept(invalid.id, "NotNewer");
  }
  const status: RemoteStatusValue =
    edited && updated !== undefined
      ? { ...refreshed, editedAt: { kind: "Edited", at: updated } }
      : refreshed;
  const replaced = await overwriteRemoteStatus(env.DB, stored, status, noteHashtags(raw));
  if (replaced.isOk()) {
    console.warn(JSON.stringify({ kind: "InvalidRemoteStatusRowReplaced", statusId: invalid.id }));
  }
  return replaced;
};
