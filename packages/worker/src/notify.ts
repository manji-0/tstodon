import type { Result } from "neverthrow";
import { err, ok } from "neverthrow";
import type { RepositoryError } from "./d1";
import { holdNotification } from "./notification-policy-store";
import { notificationDisposition } from "./notification-policy";
import { insertNotification } from "./social-store";
import { publishToAccount } from "./stream-publish";

export const notifyAccount = async (
  env: Env,
  input: {
    accountId: string;
    fromAccountId: string;
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
  return ok(undefined);
};
