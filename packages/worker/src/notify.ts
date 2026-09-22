import type { Result } from "neverthrow";
import type { RepositoryError } from "./d1";
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
  const inserted = await insertNotification(env.DB, input);
  if (inserted.isErr()) {
    return inserted;
  }
  await publishToAccount(env, input.accountId, {
    kind: "notification",
    payload: {
      type: input.kind,
      account_id: input.fromAccountId,
      status_id: input.statusId ?? null,
    },
  });
  return inserted;
};
