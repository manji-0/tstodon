import type { ApiStatusJSON } from "@tstodon/api";
import {
  type InstanceIdentity,
  IsoInstant,
  type LocalAccount,
  type LocalNote,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { noteUpdateActivity } from "./activitypub";
import { type EnqueueLocalActivityError, enqueueLocalActivity } from "./delivery";
import { synchronizesFollowers } from "./followers-synchronization";
import { startHomeFanOut } from "./home-fan-out";
import { newEntityId } from "./ids";
import { mastodonStatus } from "./local-status-documents";
import { notifyAccount } from "./notify";
import { deleteNotificationsBefore } from "./notification-store";
import { notifyNoteBoosters } from "./note-booster-updates";
import { readNoteObject } from "./local-note-object";
import { deferStatusActivity, deferToOwedActivity } from "./pending-status-federation";
import { listAcceptedQuoteEdges } from "./quote-store";
import { startPublicFanOut } from "./public-fan-out";
import { findStatusById } from "./status-store";
import { publishToAccount } from "./stream-publish";

/**
 * Tell everyone that one of the account's notes changed, as its edit does and
 * as a moderator marking it sensitive does: the `Update` that reaches remote
 * servers (when `federate`), the account's own streams, and the home and
 * public timelines. Returns the note's Mastodon document as it now reads.
 * When the note's media or quote cannot be read, the `Update` is retried
 * later rather than sent without them: receivers replace a note's
 * attachments and quote with the `Update`'s, so one without them deletes
 * them remotely. A note that still owes an activity (its `Create` not sent
 * yet) sends that one with this version instead, `federate` or not (FED-14).
 * An `Update` that cannot be stored or queued is retried later the same way,
 * since the change it announces is already stored.
 *
 * An `Unedited` change, such as a new quote policy, sends the note with the
 * `updated` it had, as Mastodon's `StatusUpdateDistributionWorker` does when
 * `edited_at` stays: a receiver applies it without recording an edit.
 */
export const announceNoteUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  updatedAt: string,
  federate: boolean,
  revision: "Edited" | "Unedited" = "Edited",
): Promise<Result<ApiStatusJSON | undefined, EnqueueLocalActivityError>> => {
  // An edit is stamped with this change, so a receiver takes it as newer than its copy.
  const stamped =
    revision === "Edited"
      ? { ...note, editedAt: IsoInstant.parse(updatedAt).unwrapOr(note.editedAt) }
      : note;
  // An owed `Update` carries an edit's time; a change that is no edit leaves
  // the note's own.
  const editedAt = revision === "Edited" ? updatedAt : undefined;
  // Whether or not this change federates, an activity the note still owes
  // goes out with this version.
  const owed = await deferToOwedActivity(env, note.id, editedAt);
  const federated =
    federate && owed === "None"
      ? await readNoteObject(env, identity, account, stamped, "Update")
      : undefined;
  // Unknown whether a `Create` is owed: the `Update` is owed instead, which
  // an owed `Create` outranks.
  const cause =
    owed === "Unknown" ? "pending" : federated?.isErr() ? federated.error.cause : undefined;
  if (federate && cause !== undefined) {
    console.error(JSON.stringify({ kind: "StatusUpdateNotFederated", statusId: note.id, cause }));
    await deferStatusActivity(env, note.id, "Update", editedAt);
  }
  if (federated?.isOk()) {
    const enqueued = await enqueueLocalActivity(
      env,
      account,
      "Update",
      noteUpdateActivity(federated.value.object, newEntityId(), updatedAt),
      { synchronizeFollowers: await synchronizesFollowers(env.DB, account.id, note.visibility) },
    );
    // The change is stored: its `Update` is sent later, as Mastodon's
    // Sidekiq retries the distribution worker, rather than lost.
    if (enqueued.isErr()) {
      console.error(
        JSON.stringify({ kind: "StatusUpdateNotFederated", statusId: note.id, cause: "enqueue" }),
      );
      await deferStatusActivity(env, note.id, "Update", editedAt);
    }
  }
  const latest = await findStatusById(env.DB, note.id);
  const rendered =
    latest.isOk() && latest.value
      ? await mastodonStatus(env, identity, latest.value, account.id)
      : ok(undefined);
  const document = rendered.isOk() ? rendered.value : undefined;
  if (document) {
    await publishToAccount(env, account.id, { kind: "status.update", payload: document });
  }
  await startHomeFanOut(env, {
    event: "status.update",
    entryId: note.id,
    author: { kind: "LocalAccount", accountId: account.id },
  });
  if (note.visibility.kind === "Public") {
    await startPublicFanOut(env, { event: "status.update", entryId: note.id });
  }
  return rendered.isErr() ? err(rendered.error) : ok(document);
};

/**
 * Tell the local accounts that boosted the note, or quote it in an accepted
 * quote, that it changed at `since`, as Mastodon's
 * `FanOutOnWriteService#notify_about_update!`: `update` to the boosters
 * (queued, {@link notifyNoteBoosters}) and `quoted_update` to the quoters.
 * Mastodon runs it for an edit, and for the quoted author's `Accept` of the
 * note's own quote, which distributes the note as an update without
 * `skip_notifications`. Each account keeps the latest such notification
 * only, as `LocalNotificationWorker` deletes the older ones. The note's
 * author is not told of its own note.
 */
export const notifyAboutUpdate = async (
  env: Env,
  note: LocalNote,
  since: string,
): Promise<Result<void, RepositoryError>> => {
  const boosters = await notifyNoteBoosters(env, {
    kind: "LocalStatus",
    statusId: note.id,
    since,
  });
  if (boosters.isErr()) {
    return boosters;
  }
  const edges = await listAcceptedQuoteEdges(env.DB, note.id);
  const quoters = (edges.isOk() ? edges.value : []).filter(
    (edge) => edge.accountId !== note.accountId,
  );
  for (const edge of quoters) {
    const notification = {
      accountId: edge.accountId,
      kind: "quoted_update",
      statusId: edge.statusId,
    } as const;
    const cleared = await deleteNotificationsBefore(env.DB, { ...notification, before: since });
    if (cleared.isOk()) {
      await notifyAccount(env, { ...notification, fromAccountId: note.accountId });
    }
  }
  return ok(undefined);
};
