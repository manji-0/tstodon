import type { ApiStatusJSON } from "@tstodon/api";
import {
  type InstanceIdentity,
  IsoInstant,
  type LocalAccount,
  type LocalNote,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { noteUpdateActivity } from "./activitypub";
import { type EnqueueLocalActivityError, enqueueLocalActivity } from "./delivery";
import { startHomeFanOut } from "./home-fan-out";
import { newEntityId } from "./ids";
import { mastodonStatus } from "./local-status-documents";
import { readNoteObject } from "./local-note-object";
import { deferStatusActivity, deferToOwedActivity } from "./pending-status-federation";
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
 */
export const announceNoteUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  updatedAt: string,
  federate: boolean,
): Promise<Result<ApiStatusJSON | undefined, EnqueueLocalActivityError>> => {
  // Stamped with this change, so a receiver takes it as newer than its copy.
  const stamped = { ...note, editedAt: IsoInstant.parse(updatedAt).unwrapOr(note.editedAt) };
  // Whether or not this change federates, an activity the note still owes
  // goes out with this version.
  const owed = await deferToOwedActivity(env, note.id, updatedAt);
  const federated =
    federate && owed === "None" ? await readNoteObject(env, identity, account, stamped) : undefined;
  // Unknown whether a `Create` is owed: the `Update` is owed instead, which
  // an owed `Create` outranks.
  const cause =
    owed === "Unknown" ? "pending" : federated?.isErr() ? federated.error.cause : undefined;
  if (federate && cause !== undefined) {
    console.error(JSON.stringify({ kind: "StatusUpdateNotFederated", statusId: note.id, cause }));
    await deferStatusActivity(env, note.id, "Update", updatedAt);
  }
  if (federated?.isOk()) {
    const enqueued = await enqueueLocalActivity(
      env,
      account,
      "Update",
      noteUpdateActivity(federated.value.object, newEntityId(), updatedAt),
    );
    if (enqueued.isErr()) {
      return enqueued.map(() => undefined);
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
