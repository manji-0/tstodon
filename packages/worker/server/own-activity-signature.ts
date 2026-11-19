import { PUBLIC_COLLECTION, type ApActivityDocumentJSON } from "@tstodon/api/activitypub";
import type { SensitiveValue } from "@tstodon/core";
import { InstanceIdentity } from "@tstodon/domain";
import { authorizedFetchEnabled } from "./authorized-fetch";
import { signLdDocument } from "./ld-signature";

/**
 * Which of its own activities tstodon Linked-Data-signs, as Mastodon v4.7.5's
 * `Payloadable#serialize_payload`: the record must answer `sign?` and the
 * caller pass a `signer`, and then it signs outside secure mode
 * (`signing_enabled?`, off with `AUTHORIZED_FETCH`) or, with `always_sign`,
 * in any mode. A signature lets another server forward the activity: a reply
 * to the followers of the thread's author, a `Delete` to its boosters'.
 *
 * - `OutsideSecureMode`: a public or unlisted status's `Create`, `Update`
 *   and `Announce` (`Status#sign?` is `distributable?`), the actor's
 *   `Update` (`Account#sign?`), a featured hashtag's `Add` and `Remove`
 *   (`FeaturedTag#sign?`) and a `QuoteRequest` (`Quote#sign?`).
 * - `Always`: what `RemoveStatusService`, `DeleteAccountService` and
 *   `RevokeQuoteService` send, the `Delete` of a public or unlisted status
 *   and the `Undo` of such a boost, the `Delete` of the actor and of a quote
 *   stamp.
 * - `Never`: the rest (a `Like`, a `Follow`, a vote, a pin, a private status).
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

/** Whether this server signs `activity` now: {@link ldSigningOf}, in its mode. */
export const ldSignsNow = (env: Env, activity: ApActivityDocumentJSON): boolean => {
  const signing = ldSigningOf(activity);
  return signing === "Always" || (signing === "OutsideSecureMode" && !authorizedFetchEnabled(env));
};

/** The local account that sends an activity, with the key that signs it. */
export type ActivitySigner = Readonly<{ username: string; privateKeyJwk: SensitiveValue<string> }>;

/**
 * `activity` signed by `signer`'s key at `now`. It is signed once, when it
 * is stored, and every inbox gets the same body, as Mastodon serializes a
 * payload once for all its deliveries. A signature that cannot be made (a
 * document the JSON-LD processor refuses, a key that does not import) is
 * logged, and the activity goes unsigned: a receiver takes it as it takes
 * any unsigned one.
 */
export const ldSignedActivity = async (
  identity: InstanceIdentity,
  signer: ActivitySigner,
  activity: ApActivityDocumentJSON,
  now: Date,
): Promise<Readonly<Record<string, unknown>>> => {
  const keyId = `${InstanceIdentity.actorUrl(identity, signer.username)}#main-key`;
  const signed = await signLdDocument(
    activity,
    { keyId, privateKeyJwk: signer.privateKeyJwk },
    now,
  );
  if (signed.isErr()) {
    console.error(
      JSON.stringify({
        kind: "ActivityNotLdSigned",
        activityId: activity.id,
        activityType: activity.type,
        reason: signed.error.kind,
      }),
    );
    return activity;
  }
  return signed.value;
};
