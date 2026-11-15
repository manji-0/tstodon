import {
  type AccountStanding,
  type InstanceIdentity,
  type MentionAncestor,
  NotificationPolicy,
  type NotificationPolicyAction,
  type NotificationSender,
  type ThreadStatus,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountStanding } from "./account-moderation-store";
import { findAccountProfile } from "./account-profile-store";
import { findAccountById } from "./account-store";
import { parseRows, type RepositoryError, runD1 } from "./d1";
import { listShownRemoteStatusMentions, listStatusMentions } from "./mention-store";
import { findNotificationPolicy, isSenderAccepted } from "./notification-policy-store";
import { RemoteAccountId } from "./remote-account-id";
import { getRemoteActorModeration } from "./remote-actor-moderation-store";
import { findRemoteActorByUri } from "./remote-actor-store";
import { findRemoteStatusById } from "./remote-status-store";
import { findStatusById } from "./status-store";
import { listThreadAncestors } from "./thread-context";

export type NotificationDisposition = NotificationPolicyAction;

type DispositionInput = Readonly<{
  recipientId: string;
  senderId: string;
  kind: string;
  statusId?: string | undefined;
}>;

/** The sender of a notification, as the tables name it. */
type Sender =
  | Readonly<{ kind: "Local"; accountId: string }>
  | Readonly<{ kind: "Remote"; actorUri: string }>;

const FollowFactsRow = z.object({
  followed: z.number(),
  follows_since: z.string().nullable(),
  created_at: z.string().nullable(),
});

type FollowFacts = Pick<
  NotificationSender,
  "followedByRecipient" | "followsRecipientSince" | "createdAt"
>;

/**
 * The accepted follows between the recipient and the sender, and when this
 * server first stored the sender, in one read. A local account's `createdAt`
 * comes with its account row instead.
 */
const followFacts = async (
  db: D1Database,
  recipientId: string,
  sender: Sender,
): Promise<Result<FollowFacts, RepositoryError>> =>
  runD1(async () => {
    const statement =
      sender.kind === "Local"
        ? db
            .prepare(
              `SELECT
                 EXISTS (SELECT 1 FROM follows
                   WHERE follower_account_id = ?1 AND target_account_id = ?2 AND kind = 'Accepted') AS followed,
                 (SELECT created_at FROM follows
                   WHERE follower_account_id = ?2 AND target_account_id = ?1 AND kind = 'Accepted') AS follows_since,
                 NULL AS created_at`,
            )
            .bind(recipientId, sender.accountId)
        : db
            .prepare(
              `SELECT
                 EXISTS (SELECT 1 FROM outbound_follows
                   WHERE account_id = ?1 AND actor_uri = ?2 AND state = 'Accepted') AS followed,
                 (SELECT created_at FROM remote_follows
                   WHERE target_account_id = ?1 AND remote_actor_uri = ?2
                     AND remote_request_kind = 'Fulfilled') AS follows_since,
                 (SELECT created_at FROM remote_actors WHERE actor_uri = ?2) AS created_at`,
            )
            .bind(recipientId, sender.actorUri);
    const [row] = parseRows(FollowFactsRow, (await statement.all()).results);
    return {
      followedByRecipient: row?.followed === 1,
      followsRecipientSince: row?.follows_since ?? undefined,
      createdAt: row?.created_at ?? "",
    };
  });

/** The mention's status, when this server holds it. */
const mentionStatus = async (
  db: D1Database,
  sender: Sender,
  statusId: string,
): Promise<Result<ThreadStatus | undefined, RepositoryError>> => {
  if (sender.kind === "Local") {
    const status = await findStatusById(db, statusId);
    return status.map((found) => (found ? { kind: "Local", status: found } : undefined));
  }
  const status = await findRemoteStatusById(db, statusId);
  return status.map((found) => (found ? { kind: "Remote", status: found } : undefined));
};

/**
 * Mastodon's `private_mention_not_in_response?`: the notification is a
 * mention on a direct status, and nothing the recipient wrote above it in
 * the thread makes it an answer (`NotificationPolicy.answersRecipient`).
 */
const unansweredPrivateMention = async (
  db: D1Database,
  identity: InstanceIdentity,
  input: DispositionInput,
  sender: Sender,
): Promise<Result<boolean, RepositoryError>> => {
  if (input.kind !== "mention" || !input.statusId) {
    return ok(false);
  }
  const status = await mentionStatus(db, sender, input.statusId);
  if (status.isErr()) {
    return err(status.error);
  }
  if (!status.value || status.value.status.visibility.kind !== "Direct") {
    return ok(false);
  }
  const above = await listThreadAncestors(
    db,
    identity,
    status.value,
    NotificationPolicy.ancestorLimit,
  );
  if (above.isErr()) {
    return err(above.error);
  }
  const idsOf = (kind: ThreadStatus["kind"]): string[] =>
    above.value.filter((ancestor) => ancestor.kind === kind).map((ancestor) => ancestor.status.id);
  const [localMentions, remoteMentions] = await Promise.all([
    listStatusMentions(db, idsOf("Local")),
    listShownRemoteStatusMentions(db, idsOf("Remote")),
  ]);
  if (localMentions.isErr()) {
    return err(localMentions.error);
  }
  if (remoteMentions.isErr()) {
    return err(remoteMentions.error);
  }
  const ancestors = above.value.toReversed().map((ancestor): MentionAncestor => {
    const mentions = (ancestor.kind === "Local" ? localMentions.value : remoteMentions.value).get(
      ancestor.status.id,
    );
    return {
      byRecipient: ancestor.kind === "Local" && ancestor.status.accountId === input.recipientId,
      direct: ancestor.status.visibility.kind === "Direct",
      mentionsSender:
        sender.kind === "Local"
          ? (mentions?.accountIds.includes(sender.accountId) ?? false)
          : (mentions?.actorUris.includes(sender.actorUri) ?? false),
    };
  });
  return ok(!NotificationPolicy.answersRecipient(ancestors));
};

/** The sender's standing and whether it is a bot. */
const senderProfile = async (
  db: D1Database,
  sender: Sender,
): Promise<Result<Readonly<{ standing: AccountStanding; bot: boolean }>, RepositoryError>> => {
  if (sender.kind === "Local") {
    const [standing, profile] = await Promise.all([
      findAccountStanding(db, sender.accountId),
      findAccountProfile(db, sender.accountId),
    ]);
    if (standing.isErr()) {
      return err(standing.error);
    }
    return profile.map((found) => ({ standing: standing.value, bot: found.bot }));
  }
  const [moderation, actor] = await Promise.all([
    getRemoteActorModeration(db, sender.actorUri),
    findRemoteActorByUri(db, sender.actorUri),
  ]);
  if (moderation.isErr()) {
    return err(moderation.error);
  }
  return actor.map((found) => ({
    standing: moderation.value.standing,
    bot: found?.profile.bot ?? false,
  }));
};

/** What `NotificationPolicy.disposition` needs to know about the sender. */
const senderFacts = async (
  db: D1Database,
  identity: InstanceIdentity,
  input: DispositionInput,
  sender: Sender,
  localCreatedAt: string | undefined,
): Promise<Result<NotificationSender, RepositoryError>> => {
  // Independent reads: one D1 round instead of one each.
  const [profile, follows, unanswered] = await Promise.all([
    senderProfile(db, sender),
    followFacts(db, input.recipientId, sender),
    unansweredPrivateMention(db, identity, input, sender),
  ]);
  if (profile.isErr()) {
    return err(profile.error);
  }
  if (follows.isErr()) {
    return err(follows.error);
  }
  if (unanswered.isErr()) {
    return err(unanswered.error);
  }
  return ok({
    ...profile.value,
    ...follows.value,
    createdAt: localCreatedAt ?? follows.value.createdAt,
    unansweredPrivateMention: unanswered.value,
  });
};

/**
 * The recipient's notification policy applied to this notification, as
 * Mastodon's `NotifyService` applies it to local and remote senders alike.
 * An accepted sender always gets through, and a sender id that is neither a
 * local account nor a remote one is accepted.
 */
export const notificationDisposition = async (
  db: D1Database,
  identity: InstanceIdentity,
  input: DispositionInput,
): Promise<Result<NotificationDisposition, RepositoryError>> => {
  // The policy and the sender's account are read with the acceptance check,
  // not after it: an accepted sender is rare, a serial round is not.
  const [accepted, policy, account] = await Promise.all([
    isSenderAccepted(db, input.recipientId, input.senderId),
    findNotificationPolicy(db, input.recipientId),
    findAccountById(db, input.senderId),
  ]);
  if (accepted.isErr()) {
    return err(accepted.error);
  }
  if (accepted.value) {
    return ok("accept");
  }
  if (policy.isErr()) {
    return err(policy.error);
  }
  if (account.isErr()) {
    return err(account.error);
  }
  let sender: Sender;
  if (account.value) {
    sender = { kind: "Local", accountId: input.senderId };
  } else {
    const actorUri = RemoteAccountId.decode(input.senderId);
    if (actorUri.isErr()) {
      return ok("accept");
    }
    sender = { kind: "Remote", actorUri: actorUri.value };
  }
  const facts = await senderFacts(db, identity, input, sender, account.value?.createdAt);
  return facts.map((found) => NotificationPolicy.disposition(policy.value, found, Date.now()));
};
