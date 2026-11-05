import type { Result } from "neverthrow";
import type { NotificationPolicyAction } from "./notification-policy-action";
import type { RepositoryError } from "./repository-error";

/** The recipient's notification policy applied to one notification. */
export type ResolveNotificationDisposition = (
  notification: Readonly<{
    recipientId: string;
    senderId: string;
    kind: string;
    statusId?: string | undefined;
  }>,
) => Promise<Result<NotificationPolicyAction, RepositoryError>>;
