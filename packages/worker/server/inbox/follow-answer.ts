import { err, ok } from "neverthrow";
import { findAccountByUsername } from "../account-store";
import { answerOutboundFollow, sendFollowUndo } from "../outbound-follow";
import {
  acceptOutboundFollow,
  findOutboundFollow,
  rejectOutboundFollow,
} from "../outbound-follow-store";
import type { InboxHandler, RemoteDelivery } from "./handler";

/**
 * The remote actor answers a local account's `Follow` of it. An `Accept` of a
 * follow the account no longer holds gets the `Undo` again; when that cannot
 * be queued the sender retries the `Accept`.
 */
export const receiveFollowAnswer: InboxHandler<RemoteDelivery<"Accept" | "Reject">> = async ({
  env,
  identity,
  signer,
  activity,
  received,
}) => {
  const answered = await answerOutboundFollow(
    {
      findAccountByUsername: (username) => findAccountByUsername(env.DB, username),
      acceptOutboundFollow: (answer) => acceptOutboundFollow(env.DB, answer),
      rejectOutboundFollow: (answer) => rejectOutboundFollow(env.DB, answer),
      holdsOutboundFollow: async (accountId, actorUri) =>
        (await findOutboundFollow(env.DB, accountId, actorUri)).map(
          (follow) => follow !== undefined,
        ),
    },
    identity,
    signer,
    { kind: activity.kind, objectId: activity.object, object: received.object },
  );
  if (answered.isErr()) {
    return err(answered.error);
  }
  if (answered.value.kind !== "AcceptedUnheld") {
    return ok(undefined);
  }
  const undone = await sendFollowUndo(
    env,
    identity,
    answered.value.follower,
    signer,
    answered.value.followActivityId,
  );
  return undone.mapErr((error) => ({
    kind: "RepositoryError" as const,
    message: "message" in error ? error.message : error.kind,
  }));
};
