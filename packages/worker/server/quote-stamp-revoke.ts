import {
  type InstanceIdentity,
  type LocalAccount,
  type LocalStatus as LocalStatusValue,
  type ThreadStatus,
} from "@tstodon/domain";
import { localNoteRef } from "./activitypub";
import { enqueueActivityToInboxes } from "./delivery";
import { type FoundStatus, foundStatusTarget } from "./found-status";
import {
  localQuoteAuthorization,
  quoteAuthorizationDeleteActivity,
} from "./quote-authorization-document";
import { statusTargetRef } from "./quote-uri";
import { quoteStampReach } from "./status-reach";
import { statusReachOperations } from "./status-reach-operations";

/** A found status as a thread node. */
const threadStatusOf = (found: FoundStatus): ThreadStatus =>
  found.kind === "LocalStatus"
    ? { kind: "Local", status: found.status }
    : { kind: "Remote", status: found.status };

/**
 * Withdraw the stamp of a revoked quote of a local status, as Mastodon's
 * `RevokeQuoteService`: one `Delete` signed by the quoted author, to
 * {@link quoteStampReach}. Best effort: the revoke stands either way.
 */
export const federateStampDeletion = async (
  env: Env,
  identity: InstanceIdentity,
  quotedAuthor: LocalAccount,
  quoted: LocalStatusValue,
  quoting: FoundStatus,
  quoteId: string,
): Promise<void> => {
  const target = localNoteRef(identity, quotedAuthor, quoted.id);
  const found = await statusTargetRef(env, identity, foundStatusTarget(quoting));
  const interacting = found.isOk() ? found.value : undefined;
  if (!interacting) {
    return;
  }
  const reach = await quoteStampReach(
    statusReachOperations(env, identity),
    { kind: "Local", status: quoted },
    threadStatusOf(quoting),
  );
  const activity = quoteAuthorizationDeleteActivity(
    localQuoteAuthorization(target, quoteId, interacting.uri),
  );
  const enqueued = reach.isErr()
    ? reach
    : await enqueueActivityToInboxes(env, quotedAuthor, "Delete", activity, reach.value);
  if (enqueued.isErr()) {
    console.error(JSON.stringify({ kind: "QuoteStampDeleteNotFederated", quoteId }));
  }
};
