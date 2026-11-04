import { InstanceIdentity, type LocalAccount, type LocalNote } from "@tstodon/domain";
import { ok, type Result } from "neverthrow";
import { noteDocument } from "./activitypub";
import { type EnqueueLocalActivityError, enqueueLocalActivity } from "./delivery";
import { enqueueHomeFanOut } from "./home-fan-out";
import { newEntityId } from "./ids";
import { mastodonStatus } from "./local-status-documents";
import { loadNoteMentions } from "./mention-resolve";
import { loadNotePoll } from "./poll-store";
import { enqueuePublicFanOut } from "./public-fan-out";
import { quotedStatusUri } from "./quote-uri";
import { loadNoteReply } from "./reply-target";
import { findStatusById } from "./status-store";
import { publishToAccount } from "./stream-publish";

/**
 * Tell everyone that one of the account's notes changed, as its edit does and
 * as a moderator marking it sensitive does: the `Update` that reaches remote
 * servers (when `federate`), the account's own streams, and the home and
 * public timelines. Returns the note's Mastodon document as it now reads.
 */
export const announceNoteUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  note: LocalNote,
  updatedAt: string,
  federate: boolean,
): Promise<Result<Record<string, unknown> | undefined, EnqueueLocalActivityError>> => {
  if (federate) {
    const actor = InstanceIdentity.actorUrl(identity, account.username);
    const enqueued = await enqueueLocalActivity(env, account.id, "Update", {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor}/statuses/${note.id}/updates/${newEntityId()}`,
      type: "Update",
      actor,
      published: updatedAt,
      object: noteDocument(identity, account, note, {
        quoteUri: await quotedStatusUri(env, identity, note.id),
        mentions: await loadNoteMentions(env.DB, identity, note.id),
        reply: await loadNoteReply(env.DB, identity, note),
        poll: await loadNotePoll(env.DB, note.id),
      }),
    });
    if (enqueued.isErr()) {
      return enqueued.map(() => undefined);
    }
  }
  const latest = await findStatusById(env.DB, note.id);
  const document =
    latest.isOk() && latest.value
      ? await mastodonStatus(env, identity, latest.value, account.id)
      : undefined;
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
  return ok(document);
};
