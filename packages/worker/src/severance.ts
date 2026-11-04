import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { notifyAccount } from "./notify";
import { type SeveranceInput, severRelationships } from "./severed-relationship-store";

/**
 * Remove the follows a moderation decision cuts, record them, and tell each
 * local account what it lost with a `severed_relationships` notification. The
 * notification is from the account to itself, as Mastodon's is. Each account
 * is notified independently: a failed delivery does not keep the rest from
 * theirs, and the first failure is the one reported.
 */
export const severAndNotify = async (
  env: Env,
  input: SeveranceInput,
): Promise<Result<void, RepositoryError>> => {
  const events = await severRelationships(env.DB, input);
  if (events.isErr()) {
    return err(events.error);
  }
  const notified = await Promise.all(
    events.value.map((event) =>
      notifyAccount(env, {
        accountId: event.accountId,
        fromAccountId: event.accountId,
        kind: "severed_relationships",
        severanceEventId: event.id,
      }),
    ),
  );
  const failed = notified.find((result) => result.isErr());
  return failed?.isErr() ? err(failed.error) : ok(undefined);
};
