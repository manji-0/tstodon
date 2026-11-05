import {
  type FindMutedThreadStatusIds,
  type HoldNotification,
  Hostname,
  type InsertNotification,
  type NewNotification,
  NotificationGroup,
  type PublishNotification,
  type ResolveNotificationDisposition,
} from "@tstodon/domain";
import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import type { RepositoryError } from "./d1";
import { holdNotification } from "./notification-policy-store";
import { notificationDisposition } from "./notification-policy";
import { isDomainBlocked } from "./domain-block-store";
import { RemoteAccountId } from "./remote-account-id";
import { findActiveMute, findBlock } from "./block-mute-store";
import { mastodonNotification } from "./notification-documents";
import { findNotificationById, groupedEntry, insertNotification } from "./notification-store";
import { enqueuePushDeliveries } from "./push-delivery";
import { parseInstanceIdentity } from "./runtime-config";
import { mutedThreadStatusIds } from "./status-mute-store";
import { publishToAccount } from "./stream-publish";

/**
 * Notification kinds that bypass the recipient's notification policy: they tell
 * admins about moderation work, or tell an account of a moderation decision.
 */
const ADMIN_KINDS: ReadonlyArray<string> = [
  "admin.report",
  "admin.sign_up",
  "severed_relationships",
];

/** What delivering a notification reads and writes. */
export type NotifyContracts = Readonly<{
  resolveDisposition: ResolveNotificationDisposition;
  findMutedThreadStatusIds: FindMutedThreadStatusIds;
  insertNotification: InsertNotification;
  holdNotification: HoldNotification;
  publishNotification: PublishNotification;
}>;

/**
 * Record a notification as the recipient's policy decides: delivered, held
 * back as a request, or dropped outright. Mastodon's moderation notifications
 * bypass the policy: a new sign-up is always "new" and "not followed".
 */
export const deliverNotification = async (
  contracts: NotifyContracts,
  input: NewNotification,
): Promise<Result<void, RepositoryError>> => {
  const disposition = ADMIN_KINDS.includes(input.kind)
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
  const inserted = await contracts.insertNotification(input);
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  if (disposition.value === "filter") {
    return contracts.holdNotification(inserted.value, input);
  }
  await contracts.publishNotification(input.accountId, inserted.value);
  return ok(undefined);
};

/** The D1, stream and push adapters behind `NotifyContracts`. */
const notifyContracts = (env: Env): NotifyContracts => {
  const identity = parseInstanceIdentity(env);
  return {
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
): Promise<Result<void, RepositoryError>> => deliverNotification(notifyContracts(env), input);

/**
 * The Notification entity the streaming API sends, as `GET
 * /api/v1/notifications/:id` renders it, with the `group_key` the web UI
 * files it under.
 */
const streamedNotification = async (
  env: Env,
  recipientId: string,
  notificationId: string,
): Promise<Record<string, unknown> | undefined> => {
  const identity = parseInstanceIdentity(env);
  const row = await findNotificationById(env.DB, recipientId, notificationId);
  if (identity.isErr() || row.isErr() || !row.value) {
    return undefined;
  }
  const document = await mastodonNotification(env, identity.value, row.value, recipientId);
  return document
    ? {
        ...document,
        group_key: NotificationGroup.key(
          groupedEntry(row.value),
          new Set(NotificationGroup.defaultGroupedTypes),
        ),
      }
    : undefined;
};

/**
 * A notification from a remote actor. Its sender id is the actor's `r_…`
 * account id; a recipient who blocks the actor, mutes its notifications, or
 * blocks its domain gets none (blocks and mutes also hide earlier ones when
 * the list is read).
 */
export const notifyFromRemote = async (
  env: Env,
  input: Readonly<{
    accountId: string;
    actorUri: string;
    kind: string;
    statusId?: string;
    targetAccountId?: string;
  }>,
): Promise<Result<void, RepositoryError>> => {
  const blocked = await findBlock(env.DB, input.accountId, input.actorUri);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  const muted = await findActiveMute(env.DB, input.accountId, input.actorUri);
  if (muted.isErr()) {
    return err(muted.error);
  }
  const domain = Hostname.ofUri(input.actorUri);
  const domainBlocked = domain ? await isDomainBlocked(env.DB, input.accountId, domain) : ok(false);
  if (domainBlocked.isErr()) {
    return err(domainBlocked.error);
  }
  if (blocked.value || muted.value?.notifications || domainBlocked.value) {
    return ok(undefined);
  }
  return notifyAccount(env, {
    accountId: input.accountId,
    fromAccountId: RemoteAccountId.encode(input.actorUri),
    fromActorUri: input.actorUri,
    kind: input.kind,
    ...(input.statusId ? { statusId: input.statusId } : {}),
    ...(input.targetAccountId ? { targetAccountId: input.targetAccountId } : {}),
  });
};
