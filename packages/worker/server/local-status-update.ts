import type { ApiStatusJSON } from "@tstodon/api";
import { InstanceIdentity, IsoInstant, type LocalAccount, type LocalNote } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { noteDocument } from "./activitypub";
import { type EnqueueLocalActivityError, enqueueLocalActivity } from "./delivery";
import { enqueueHomeFanOut } from "./home-fan-out";
import { newEntityId } from "./ids";
import { mastodonStatus } from "./local-status-documents";
import { loadNoteMentions } from "./mention-resolve";
import { loadNoteMedia } from "./note-attachments";
import { loadNotePoll } from "./poll-store";
import { enqueuePublicFanOut } from "./public-fan-out";
import { loadNoteQuotePolicy } from "./quote-policy-name";
import { noteQuote } from "./quote-uri";
import { loadNoteReply } from "./reply-target";
import { findStatusById } from "./status-store";
import { publishToAccount } from "./stream-publish";

/**
 * Tell everyone that one of the account's notes changed, as its edit does and
 * as a moderator marking it sensitive does: the `Update` that reaches remote
 * servers (when `federate`), the account's own streams, and the home and
 * public timelines. Returns the note's Mastodon document as it now reads.
 * When the note's media cannot be read, no `Update` is sent: receivers replace
 * a note's attachments with the `Update`'s, so one without them deletes the
 * media remotely.
 */
export const announceNoteUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  updatedAt: string,
  federate: boolean,
): Promise<Result<ApiStatusJSON | undefined, EnqueueLocalActivityError>> => {
  const media = federate ? await loadNoteMedia(env.DB, identity, note) : undefined;
  if (media?.isErr()) {
    console.error(JSON.stringify({ kind: "StatusUpdateNotFederated", statusId: note.id }));
  }
  if (media?.isOk()) {
    const actor = InstanceIdentity.actorUrl(identity, account.username);
    const enqueued = await enqueueLocalActivity(env, account.id, "Update", {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor}/statuses/${note.id}/updates/${newEntityId()}`,
      type: "Update",
      actor,
      published: updatedAt,
      // Stamped with this change, so a receiver takes it as newer than its copy.
      object: noteDocument(
        identity,
        account,
        { ...note, editedAt: IsoInstant.parse(updatedAt).unwrapOr(note.editedAt) },
        {
          quote: await noteQuote(env, identity, note.id),
          mentions: await loadNoteMentions(env.DB, identity, note.id),
          reply: await loadNoteReply(env.DB, identity, note),
          poll: await loadNotePoll(env.DB, note.id),
          media: media.value,
          quotePolicy: await loadNoteQuotePolicy(env.DB, account, note),
        },
      ),
    });
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
  await enqueueHomeFanOut(env, {
    event: "status.update",
    entryId: note.id,
    author: { kind: "LocalAccount", accountId: account.id },
  });
  if (note.visibility.kind === "Public") {
    await enqueuePublicFanOut(env, { event: "status.update", entryId: note.id });
  }
  return rendered.isErr() ? err(rendered.error) : ok(document);
};
