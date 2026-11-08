import { err, ok, type Result } from "neverthrow";
import { listAdminAccountIds } from "./account-admin-store";
import type { RepositoryError } from "./d1";
import { notifyAccount } from "./notify";

/**
 * Tell every admin but `fromAccountId` about moderation work, as Mastodon
 * does for users whose role may manage reports (`admin.report`) or users
 * (`admin.sign_up`). Each admin is notified independently: one failing
 * delivery does not keep the others from theirs.
 */
export const notifyAdmins = async (
  env: Env,
  input: Readonly<{
    kind: "admin.report" | "admin.sign_up";
    /** The reporter, or the new user: a local id, or `r_…` for a remote reporter. */
    fromAccountId: string;
    /** The reporter's actor URI when it is a remote actor. */
    fromActorUri?: string;
    reportId?: string;
  }>,
): Promise<Result<void, RepositoryError>> => {
  const admins = await listAdminAccountIds(env.DB);
  if (admins.isErr()) {
    return err(admins.error);
  }
  const results = await Promise.all(
    admins.value
      .filter((adminId) => adminId !== input.fromAccountId)
      .map((accountId) =>
        notifyAccount(env, {
          accountId,
          fromAccountId: input.fromAccountId,
          ...(input.fromActorUri ? { fromActorUri: input.fromActorUri } : {}),
          kind: input.kind,
          ...(input.reportId ? { reportId: input.reportId } : {}),
        }),
      ),
  );
  const failed = results.find((result) => result.isErr());
  return failed?.isErr() ? err(failed.error) : ok(undefined);
};
