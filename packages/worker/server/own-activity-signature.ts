import {
  type ApActivityDocumentJSON,
  type ApContextJSON,
  PUBLIC_COLLECTION,
  SECURITY_V1,
} from "@tstodon/api/activitypub";
import { InstanceIdentity, type LocalAccount } from "@tstodon/domain";
import { authorizedFetchEnabled } from "./authorized-fetch";
import { ldSignature } from "./ld-signature";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";

/**
 * Which of its own activities tstodon Linked-Data-signs, as Mastodon v4.7.5's
 * `Payloadable#serialize_payload`: the record must answer `sign?` and the
 * caller pass a `signer`, and then it signs outside secure mode
 * (`signing_enabled?`: off with `AUTHORIZED_FETCH` or in limited federation,
 * `authorized_fetch_mode?`) or, with `always_sign`, in any mode. A
 * signature lets another server forward the activity: a reply
 * to the followers of the thread's author, a `Delete` to its boosters'.
 *
 * - `OutsideSecureMode`: a public or unlisted status's `Create`, `Update`
 *   and `Announce` (`Status#sign?` is `distributable?`), the actor's
 *   `Update` (`Account#sign?`), a featured hashtag's `Add` and `Remove`
 *   (`FeaturedTag#sign?`) and a `QuoteRequest` (`Quote#sign?`). The
 *   `QuoteRequest` inlines the quoting status as its `instrument`, so a
 *   followers-only or direct quote is signed there too, as in Mastodon.
 * - `Always`: what `RemoveStatusService`, `DeleteAccountService` and
 *   `RevokeQuoteService` send, the `Delete` of a public or unlisted status
 *   and the `Undo` of such a boost, the `Delete` of the actor and of a quote
 *   stamp.
 * - `Never`: the rest (a `Like`, a `Follow`, a vote, a pin, and the
 *   `Create`, `Update`, `Announce`, `Delete` or `Undo` of a followers-only or
 *   direct status).
 */
export type LdSigning = "Never" | "OutsideSecureMode" | "Always";

type Addressed = Readonly<{
  to?: ReadonlyArray<string> | undefined;
  cc?: ReadonlyArray<string> | undefined;
}>;

/** Mastodon's `Status#distributable?`: public or unlisted, which names the public collection. */
const distributable = (addressed: Addressed): boolean =>
  [...(addressed.to ?? []), ...(addressed.cc ?? [])].includes(PUBLIC_COLLECTION);

export const ldSigningOf = (activity: ApActivityDocumentJSON): LdSigning => {
  switch (activity.type) {
    case "Create":
      return activity.object.type !== "Note" && activity.object.type !== "Question"
        ? "Never"
        : distributable(activity.object)
          ? "OutsideSecureMode"
          : "Never";
    case "Update":
      return activity.object.type === "Note" || activity.object.type === "Question"
        ? distributable(activity.object)
          ? "OutsideSecureMode"
          : "Never"
        : "OutsideSecureMode";
    case "Announce":
      return distributable(activity) ? "OutsideSecureMode" : "Never";
    case "Delete":
      return typeof activity.object === "string" || activity.object.type !== "Tombstone"
        ? "Always"
        : distributable(activity)
          ? "Always"
          : "Never";
    case "Undo":
      return activity.object.type === "Announce" && distributable(activity.object)
        ? "Always"
        : "Never";
    case "Add":
    case "Remove":
      return typeof activity.object !== "string" && activity.object.type === "Hashtag"
        ? "OutsideSecureMode"
        : "Never";
    case "QuoteRequest":
      return "OutsideSecureMode";
    default:
      return "Never";
  }
};

/**
 * `activity` as `account` delivers it: Linked-Data-signed with the account's
 * key when {@link ldSigningOf} says Mastodon would sign it in this server's
 * mode, as it is otherwise, and as it is when it already carries a
 * signature. Secure mode is `AUTHORIZED_FETCH` or limited federation (an
 * allow list); `allowHosts` is that list when the caller has read it.
 *
 * Sign once per activity, when it is stored: every inbox gets the same body,
 * as Mastodon serializes a payload once for all its deliveries. A signature
 * that cannot be made (a document the JSON-LD processor refuses, a key that
 * does not import) is logged, and the activity goes unsigned: a receiver
 * takes it as it takes any unsigned one.
 */
export const deliveredActivity = async (
  env: Env,
  account: LocalAccount,
  activity: ApActivityDocumentJSON,
  allowHosts?: ReadonlySet<string>,
): Promise<ApActivityDocumentJSON> => {
  const signing = ldSigningOf(activity);
  if (activity.signature !== undefined || signing === "Never") {
    return activity;
  }
  if (
    signing === "OutsideSecureMode" &&
    (authorizedFetchEnabled(env) || (allowHosts ?? (await federationAllowHosts(env))).size > 0)
  ) {
    return activity;
  }
  const identity = parseInstanceIdentity(env);
  const signature = identity.isErr()
    ? undefined
    : await ldSignature(
        activity,
        {
          keyId: `${InstanceIdentity.actorUrl(identity.value, account.username)}#main-key`,
          privateKeyJwk: account.privateKeyJwk,
        },
        new Date(),
      );
  if (signature === undefined || signature.isErr()) {
    console.error(
      JSON.stringify({
        kind: "ActivityNotLdSigned",
        activityId: activity.id,
        activityType: activity.type,
        reason: signature?.isErr() ? signature.error.kind : "InvalidIdentity",
      }),
    );
    return activity;
  }
  return {
    ...activity,
    "@context": withSecurity(activity["@context"]),
    signature: signature.value,
  };
};

/** `context` with the security vocabulary, which `sign!` adds after signing. */
const withSecurity = (context: ApContextJSON): ApContextJSON =>
  typeof context === "string"
    ? [context, SECURITY_V1]
    : context.includes(SECURITY_V1)
      ? context
      : [...context, SECURITY_V1];
