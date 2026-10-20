import { InstanceIdentity } from "@tstodon/domain";
import { findAccountById } from "./account-store";
import { findQuoteByStatusId } from "./quote-store";
import { findStatusById } from "./status-store";

/**
 * The ActivityPub URI of the status this note quotes, for the `quote`
 * property. An absent, revoked, or dangling quote has no URI.
 */
export const quotedStatusUri = async (
  env: Env,
  identity: InstanceIdentity,
  statusId: string,
): Promise<string | undefined> => {
  const quote = await findQuoteByStatusId(env.DB, statusId);
  if (quote.isErr() || !quote.value || quote.value.state !== "accepted") {
    return undefined;
  }
  const target = await findStatusById(env.DB, quote.value.quotedStatusId);
  if (target.isErr() || !target.value) {
    return undefined;
  }
  const author = await findAccountById(env.DB, target.value.accountId);
  if (author.isErr() || !author.value) {
    return undefined;
  }
  return `${InstanceIdentity.actorUrl(identity, author.value.username)}/statuses/${target.value.id}`;
};
