import {
  type InstanceIdentity,
  NoteThread,
  type RemoteStatus,
  StatusNotificationAudience,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { announceHomeEntry } from "./home-fan-out";
import { addDeliveredRemoteStatusMention } from "./mention-store";
import { notifyFromRemoteOnce } from "./notify";
import { findOutboundFollow, isNotifyingRemoteFollower } from "./outbound-follow-store";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";

/**
 * A `Create` of the note `status`, which this server holds already, came
 * from its author to the personal inbox of `accountId`, as Mastodon's
 * `Create#postprocess_audience_and_deliver`. The account gets a silent
 * mention unless the note names it, and a direct note is then limited; an
 * account the note named already changes nothing. One that follows the
 * author then has the note put on its home, as `FeedInsertWorker` does.
 * No mention notification is sent, as for any silent mention.
 *
 * Only the mention is retried: a redelivery finds it and stops, so what
 * follows it is best effort, as Mastodon queues it in a job of its own.
 */
export const deliverHeldRemoteNote = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatus,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const added = await addDeliveredRemoteStatusMention(env.DB, status.id, accountId);
  if (added.isErr()) {
    return err(added.error);
  }
  if (added.value) {
    const fed = await insertIntoHome(env, identity, status, accountId);
    if (fed.isErr()) {
      console.error(JSON.stringify({ kind: "HeldNoteHomeInsertFailed", statusId: status.id }));
    }
  }
  return ok(undefined);
};

/**
 * `FeedInsertWorker` for the home of `accountId`, when it follows the
 * author: its `user` stream hears the note, and a follow that asks for
 * notifications gets the note's `status` notification unless the home
 * would filter the note or it replies to someone else (`notify?`).
 */
const insertIntoHome = async (
  env: Env,
  identity: InstanceIdentity,
  status: RemoteStatus,
  accountId: string,
): Promise<Result<void, RepositoryError>> => {
  const follow = await findOutboundFollow(env.DB, accountId, status.actorUri);
  if (follow.isErr()) {
    return err(follow.error);
  }
  if (follow.value?.state.kind !== "Accepted") {
    return ok(undefined);
  }
  const streamed = await announceHomeEntry(env, identity, { event: "update", entryId: status.id }, [
    accountId,
  ]);
  if (streamed.isErr() || !follow.value.notify) {
    return streamed;
  }
  const notifying = await isNotifyingRemoteFollower(env.DB, accountId, status.actorUri, status.id);
  const targets = await findRemoteStatusReplyTargets(env.DB, [status.id]);
  if (notifying.isErr() || targets.isErr()) {
    return notifying.andThen(() => targets).map(() => undefined);
  }
  const thread = NoteThread.of(targets.value.get(status.id)?.replyLink ?? { kind: "NotReply" }, {
    kind: "RemoteActor",
    actorUri: status.actorUri,
  });
  const notified =
    notifying.value &&
    StatusNotificationAudience.recipients(
      {
        visibility: status.visibility,
        thread,
        language: status.language,
        addressed: new Set([accountId]),
      },
      [{ accountId, languages: follow.value.languages }],
    ).length > 0;
  return notified
    ? notifyFromRemoteOnce(env, {
        accountId,
        actorUri: status.actorUri,
        kind: "status",
        statusId: status.id,
      })
    : ok(undefined);
};
