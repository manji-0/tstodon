import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { notifyAccount } from "./notify";
import {
  type AccountSeveranceEvent,
  type SeveranceInput,
  severRelationships,
} from "./severed-relationship-store";

/**
 * Tell each local account what it lost with a `severed_relationships`
 * notification. The notification is from the account to itself, as
 * Mastodon's is. Each account is notified independently: a failed delivery
 * does not keep the rest from theirs, and the first failure is the one
 * reported.
 */
export const notifySeverance = async (
  env: Env,
  events: ReadonlyArray<AccountSeveranceEvent>,
): Promise<Result<void, RepositoryError>> => {
  const notified = await Promise.all(
    events.map((event) =>
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

/** Remove the follows a moderation decision cuts, record them, and notify each account. */
export const severAndNotify = async (
  env: Env,
  input: SeveranceInput,
): Promise<Result<void, RepositoryError>> => {
  const events = await severRelationships(env.DB, input);
  if (events.isErr()) {
    return err(events.error);
  }
  return notifySeverance(env, events.value);
};
