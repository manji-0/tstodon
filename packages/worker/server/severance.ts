import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { startJob } from "./inline-job";
import { notifyAccount } from "./notify";
import { processSendSeveranceNoticesJob } from "./severance-notices";
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

/**
 * Remove the follows a domain suspension cuts, record them, notify each
 * account, and start telling the suspended server: the notices are stored
 * with the removal, and the `SendSeveranceNotices` pages send them, as
 * Mastodon's `DeleteAccountService` sends a `Reject(Follow)` for each of the
 * domain's follows (`reject_follows!`) and an `Undo(Follow)` for each follow
 * of it (`undo_follows!`), though the domain is suspended. A page the queue
 * refuses is left to the hourly cron.
 */
export const severAndNotify = async (
  env: Env,
  input: SeveranceInput,
): Promise<Result<void, RepositoryError>> => {
  const events = await severRelationships(env.DB, input);
  if (events.isErr()) {
    return err(events.error);
  }
  await startJob(env, { kind: "SendSeveranceNotices" }, processSendSeveranceNoticesJob, "Queued");
  return notifySeverance(env, events.value);
};
