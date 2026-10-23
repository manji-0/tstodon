import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import type { RepositoryError } from "./d1";
import { holdNotification } from "./notification-policy-store";
import { notificationDisposition } from "./notification-policy";
import { hostnameOf, isDomainBlocked } from "./domain-block-store";
import { RemoteAccountId } from "./remote-account-id";
import { findActiveMute, findBlock } from "./block-mute-store";
import { insertNotification } from "./notification-store";
import { enqueuePushDeliveries } from "./push-delivery";
import { parseInstanceIdentity } from "./runtime-config";
import { mutedThreadStatusIds } from "./status-mute-store";
import { publishToAccount } from "./stream-publish";

export const notifyAccount = async (
  env: Env,
  input: {
    accountId: string;
    fromAccountId: string;
    /** The sender's actor URI when it is a remote account. */
    fromActorUri?: string;
    kind: string;
    statusId?: string;
  },
): Promise<Result<void, RepositoryError>> => {
  // The recipient's notification policy decides whether this is delivered,
  // held back as a request, or dropped outright.
  const disposition = await notificationDisposition(env.DB, {
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
    const identity = parseInstanceIdentity(env);
    if (identity.isOk()) {
      const muted = await mutedThreadStatusIds(env.DB, identity.value, input.accountId, [
        input.statusId,
      ]);
      if (muted.isErr()) {
        return err(muted.error);
      }
      if (muted.value.has(input.statusId)) {
        return ok(undefined);
      }
    }
  }
  const inserted = await insertNotification(env.DB, input);
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  if (disposition.value === "filter") {
    const held = await holdNotification(
      env.DB,
      inserted.value,
      input.accountId,
      input.fromAccountId,
      input.statusId,
    );
    if (held.isErr()) {
      return err(held.error);
    }
    return ok(undefined);
  }
  await publishToAccount(env, input.accountId, {
    kind: "notification",
    payload: {
      type: input.kind,
      account_id: input.fromAccountId,
      status_id: input.statusId ?? null,
    },
  });
  await enqueuePushDeliveries(env, input.accountId, inserted.value);
  return ok(undefined);
};

/**
 * A notification from a remote actor. Its sender id is the actor's `r_…`
 * account id; a recipient who blocks the actor, mutes its notifications, or
 * blocks its domain gets none (blocks and mutes also hide earlier ones when
 * the list is read).
 */
export const notifyFromRemote = async (
  env: Env,
  input: Readonly<{ accountId: string; actorUri: string; kind: string; statusId?: string }>,
): Promise<Result<void, RepositoryError>> => {
  const blocked = await findBlock(env.DB, input.accountId, input.actorUri);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  const muted = await findActiveMute(env.DB, input.accountId, input.actorUri);
  if (muted.isErr()) {
    return err(muted.error);
  }
  const domain = hostnameOf(input.actorUri);
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
  });
};
