import type { ApiNotificationJSON } from "@tstodon/api";
import { assertNever } from "@tstodon/core";
import {
  FediRole,
  type FediRoleValue,
  type FindMutedThreadStatusIds,
  type HoldNotification,
  type InsertNotification,
  AccountPresentation,
  LocalFollow,
  type MentionedPost,
  type NewNotification,
  type NotificationPolicyAction,
  type PublishNotification,
  type ResolveNotificationDisposition,
  type ScreenSender,
  type SenderScreening,
  type ThreadStatus,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import { listAdminAccountIds } from "./account-admin-store";
import type { RepositoryError } from "./d1";
import type { FollowWrite } from "./follow-store";
import { holdNotification } from "./notification-policy-store";
import { findOutboundFollow } from "./outbound-follow-store";
import { notificationDisposition } from "./notification-policy";
import { isActorDomainBlocked } from "./domain-block-store";
import { RemoteAccountId } from "./remote-account-id";
import { localAccountPresentations } from "./account-presentation";
import { findActiveMute, findBlock, silencesAnyOf } from "./block-mute-store";
import { findRemoteBlock } from "./remote-block-store";
import { mastodonNotification } from "./notification-documents";
import {
  findNotificationById,
  hasRemoteNotification,
  insertNotification,
} from "./notification-store";
import { enqueuePushDeliveries } from "./push-delivery";
import { parseInstanceIdentity } from "./runtime-config";
import { mutedThreadStatusIds } from "./status-mute-store";
import { publishToAccount } from "./stream-publish";

/**
 * Notification kinds that bypass the recipient's notification policy: the
 * types Mastodon 4.5 marks `filterable: false` in `Notification::PROPERTIES`.
 * A silenced sender still drops them (`deliverNotification`).
 */
const POLICY_EXEMPT_KINDS: ReadonlyArray<string> = [
  "status",
  "poll",
  "update",
  "quoted_update",
  "severed_relationships",
  "moderation_warning",
  "annual_report",
  "admin.sign_up",
  "admin.report",
];

/**
 * The kinds an account is still notified of about itself, as Mastodon's
 * `DropCondition#drop?` exempts them from `from_self?`.
 */
const SELF_NOTIFIED_KINDS: ReadonlyArray<string> = [
  "poll",
  "severed_relationships",
  "moderation_warning",
  "annual_report",
];

const DROP = { kind: "Drop" } as const satisfies SenderScreening;
const BYPASS = { kind: "Bypass" } as const satisfies SenderScreening;
const SCREEN = { kind: "Screen" } as const satisfies SenderScreening;

/** What delivering a notification reads and writes. */
export type NotifyContracts = Readonly<{
  screenSender: ScreenSender;
  resolveDisposition: ResolveNotificationDisposition;
  findMutedThreadStatusIds: FindMutedThreadStatusIds;
  insertNotification: InsertNotification;
  holdNotification: HoldNotification;
  publishNotification: PublishNotification;
}>;

/**
 * Record a notification as the recipient's policy decides: delivered, held
 * back as a request, or dropped outright. As Mastodon's NotifyService, the
 * sender is screened first: a suspended recipient is notified of nothing,
 * nothing of any kind comes from the recipient itself or a sender it
 * silenced, and a staff mention skips every filter. A mention also needs its
 * post (`mentionedPost`) to be screened as Mastodon's `blocked_mention?`.
 * The non-filterable kinds then bypass the policy.
 */
export const deliverNotification = async (
  contracts: NotifyContracts,
  input: NewNotification,
  mentionedPost?: MentionedPost,
): Promise<Result<void, RepositoryError>> => {
  const screening = await contracts.screenSender(input, mentionedPost);
  if (screening.isErr()) {
    return err(screening.error);
  }
  switch (screening.value.kind) {
    case "Drop":
      return ok(undefined);
    case "Bypass":
      return recordNotification(contracts, input, "accept");
    case "Screen":
      return deliverScreened(contracts, input);
    default:
      return assertNever(screening.value);
  }
};

const deliverScreened = async (
  contracts: NotifyContracts,
  input: NewNotification,
): Promise<Result<void, RepositoryError>> => {
  const disposition = POLICY_EXEMPT_KINDS.includes(input.kind)
    ? ok("accept" as const)
    : await contracts.resolveDisposition({
        recipientId: input.accountId,
        senderId: input.fromAccountId,
        kind: input.kind,
        statusId: input.statusId,
      });
  if (disposition.isErr()) {
    return err(disposition.error);
  }
  if (disposition.value === "drop") {
    return ok(undefined);
  }
  // As Mastodon's NotifyService: nothing about a status in a conversation the
  // recipient muted, so the list, groups, unread count, and push all agree.
  if (input.statusId) {
    const muted = await contracts.findMutedThreadStatusIds(input.accountId, [input.statusId]);
    if (muted.isErr()) {
      return err(muted.error);
    }
    if (muted.value.has(input.statusId)) {
      return ok(undefined);
    }
  }
  return recordNotification(contracts, input, disposition.value);
};

const recordNotification = async (
  contracts: NotifyContracts,
  input: NewNotification,
  disposition: Exclude<NotificationPolicyAction, "drop">,
): Promise<Result<void, RepositoryError>> => {
  const inserted = await contracts.insertNotification(input);
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  if (disposition === "filter") {
    return contracts.holdNotification(inserted.value, input);
  }
  await contracts.publishNotification(input.accountId, inserted.value);
  return ok(undefined);
};

/** The D1, stream and push adapters behind `NotifyContracts`. */
const notifyContracts = (env: Env): NotifyContracts => {
  const identity = parseInstanceIdentity(env);
  return {
    screenSender: (notification, mentionedPost) =>
      screenSender(env.DB, notification, mentionedPost),
    resolveDisposition: (notification) => notificationDisposition(env.DB, notification),
    findMutedThreadStatusIds: (accountId, statusIds) =>
      identity.isOk()
        ? mutedThreadStatusIds(env.DB, identity.value, accountId, statusIds)
        : Promise.resolve(ok(new Set())),
    insertNotification: (notification) => insertNotification(env.DB, notification),
    holdNotification: (notificationId, notification) =>
      holdNotification(
        env.DB,
        notificationId,
        notification.accountId,
        notification.fromAccountId,
        notification.statusId,
      ),
    publishNotification: async (accountId, notificationId) => {
      const streamed = await streamedNotification(env, accountId, notificationId);
      if (streamed) {
        await publishToAccount(env, accountId, { kind: "notification", payload: streamed });
      }
      await enqueuePushDeliveries(env, accountId, notificationId);
    },
  };
};

export const notifyAccount = (
  env: Env,
  input: NewNotification,
  mentionedPost?: MentionedPost,
): Promise<Result<void, RepositoryError>> =>
  deliverNotification(notifyContracts(env), input, mentionedPost);

/**
 * The `MentionedPost` of a post that mentions `mentioned` (local account ids
 * and remote actor URIs) and replies to `replyTo`.
 */
export const mentionedPost = (
  mentioned: ReadonlyArray<string>,
  replyTo: ThreadStatus | undefined,
): MentionedPost => ({
  involvedAccounts: [
    ...mentioned,
    ...(replyTo === undefined
      ? []
      : [replyTo.kind === "Local" ? replyTo.status.accountId : replyTo.status.actorUri]),
  ],
});

/** Notify the target of a follow `followAccount` created; following again does not notify. */
export const notifyNewFollow = async (
  env: Env,
  followerId: string,
  targetId: string,
  written: FollowWrite,
): Promise<Result<void, RepositoryError>> =>
  written.kind === "Created"
    ? notifyAccount(env, {
        accountId: targetId,
        fromAccountId: followerId,
        kind: LocalFollow.notificationKind(written.follow),
      })
    : ok(undefined);

/**
 * The Notification entity the streaming API sends, as `GET
 * /api/v1/notifications/:id` renders it, with the `group_key` the web UI
 * files it under.
 */
const streamedNotification = async (
  env: Env,
  recipientId: string,
  notificationId: string,
): Promise<ApiNotificationJSON | undefined> => {
  const identity = parseInstanceIdentity(env);
  const row = await findNotificationById(env.DB, recipientId, notificationId);
  if (identity.isErr() || row.isErr() || !row.value) {
    return undefined;
  }
  const rendered = await mastodonNotification(env, identity.value, row.value, recipientId);
  return rendered.isOk() ? rendered.value : undefined;
};

/**
 * The recipient and sender checks of Mastodon's `DropCondition#drop?`, with
 * `blocked_mention?` for a mention. Blocks and mutes name a remote account by
 * its actor URI and a local one by its account id; only a remote sender has
 * a domain to block.
 */
const screenSender = async (
  db: D1Database,
  notification: NewNotification,
  mentionedPost: MentionedPost | undefined,
): Promise<Result<SenderScreening, RepositoryError>> => {
  const recipientId = notification.accountId;
  const recipient = await localAccountPresentations(db, [recipientId]);
  if (recipient.isErr()) {
    return err(recipient.error);
  }
  const presentation = recipient.value.get(recipientId);
  if (presentation && !AccountPresentation.available(presentation)) {
    return ok(DROP);
  }
  if (notification.fromAccountId === recipientId) {
    return ok(SELF_NOTIFIED_KINDS.includes(notification.kind) ? SCREEN : DROP);
  }
  if (notification.kind === "mention" && !notification.fromActorUri) {
    const staff = await isStaffSender(db, notification.fromAccountId, recipientId);
    if (staff.isErr()) {
      return err(staff.error);
    }
    if (staff.value) {
      return ok(BYPASS);
    }
  }
  const sender = notification.fromActorUri ?? notification.fromAccountId;
  // Every notification pays for this check, so the two lookups run together.
  const [blocked, muted, blockedBySender] = await Promise.all([
    findBlock(db, recipientId, sender),
    findActiveMute(db, recipientId, sender),
    findRemoteBlock(db, notification.fromActorUri ?? "", recipientId),
  ]);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (muted.isErr()) {
    return err(muted.error);
  }
  if (blockedBySender.isErr()) {
    return err(blockedBySender.error);
  }
  if (blocked.value || blockedBySender.value || muted.value?.notifications) {
    return ok(DROP);
  }
  if (notification.kind === "mention" && mentionedPost) {
    const involved = await silencesAnyOf(db, recipientId, mentionedPost.involvedAccounts);
    if (involved.isErr()) {
      return err(involved.error);
    }
    if (involved.value) {
      return ok(DROP);
    }
  }
  const actorUri = notification.fromActorUri;
  if (!actorUri) {
    return ok(SCREEN);
  }
  const domainBlocked = await isActorDomainBlocked(db, recipientId, actorUri);
  if (domainBlocked.isErr()) {
    return err(domainBlocked.error);
  }
  if (!domainBlocked.value) {
    return ok(SCREEN);
  }
  // The recipient's own follow outweighs its block of the sender's domain.
  const follow = await findOutboundFollow(db, recipientId, actorUri);
  return follow.map((found) => (found?.state.kind === "Accepted" ? SCREEN : DROP));
};

/**
 * Mastodon's `from_staff?`: a local sender whose role bypasses the
 * recipient's blocks. Roles come from the sign-in user's `role` column,
 * which `ADMIN_USERNAMES` seeds.
 */
const isStaffSender = async (
  db: D1Database,
  senderId: string,
  recipientId: string,
): Promise<Result<boolean, RepositoryError>> => {
  const admins = await listAdminAccountIds(db);
  const roleOf = (ids: ReadonlyArray<string>, id: string): FediRoleValue =>
    ids.includes(id) ? FediRole.Admin : FediRole.User;
  return admins.map((ids) =>
    FediRole.bypassesBlock(roleOf(ids, senderId), roleOf(ids, recipientId)),
  );
};

/** A notification from a remote actor, whose sender id is the actor's `r_…` account id. */
export const notifyFromRemote = (
  env: Env,
  input: Readonly<{
    accountId: string;
    actorUri: string;
    kind: string;
    statusId?: string;
    targetAccountId?: string;
  }>,
  mentionedPost?: MentionedPost,
): Promise<Result<void, RepositoryError>> =>
  notifyAccount(
    env,
    {
      accountId: input.accountId,
      fromAccountId: RemoteAccountId.encode(input.actorUri),
      fromActorUri: input.actorUri,
      kind: input.kind,
      ...(input.statusId ? { statusId: input.statusId } : {}),
      ...(input.targetAccountId ? { targetAccountId: input.targetAccountId } : {}),
    },
    mentionedPost,
  );

/**
 * {@link notifyFromRemote}, unless the account already holds a notification
 * of this kind from this actor about this status, created at `since` or later
 * (at any time by default). A delivery that is applied again after a failure
 * calls this, so the work it repeats notifies nobody twice. A notification
 * the first attempt dropped (a block, a mute, the policy) left no row, and is
 * screened again.
 */
export const notifyFromRemoteOnce = async (
  env: Env,
  input: Readonly<{ accountId: string; actorUri: string; kind: string; statusId: string }>,
  since?: string,
  mentionedPost?: MentionedPost,
): Promise<Result<void, RepositoryError>> => {
  const sent = await hasRemoteNotification(env.DB, input, since);
  if (sent.isErr()) {
    return err(sent.error);
  }
  return sent.value ? ok(undefined) : notifyFromRemote(env, input, mentionedPost);
};
