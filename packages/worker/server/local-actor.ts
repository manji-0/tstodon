import { type ApActorDocumentJSON, PUBLIC_COLLECTION } from "@tstodon/api/activitypub";
import { InstanceIdentity, type LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { listAccountAliases } from "./account-alias-store";
import { findAccountMove } from "./account-move-store";
import { findAccountStanding } from "./account-moderation-store";
import { findAccountProfile } from "./account-profile-store";
import { type ActorProfile, actorDocument } from "./activitypub";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { loadCustomEmojis } from "./custom-emoji-store";
import { emojisInTexts } from "./emoji";
import { enqueueLocalActivity, type EnqueueLocalActivityError } from "./delivery";
import { newEntityId } from "./ids";

/**
 * The actor document of a local account as it stands now: its profile (bio,
 * avatar, header, fields, flags and the custom emoji they use, or none of it
 * while suspended), the accounts it moved from (`alsoKnownAs`) and, while a
 * move stands, the account it moved to (`movedTo`).
 */
export const localActorDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Result<ApActorDocumentJSON, RepositoryError>> => {
  const [aliases, move, profile, standing, emojis] = await Promise.all([
    listAccountAliases(env.DB, account.id),
    findAccountMove(env.DB, account.id),
    findAccountProfile(env.DB, account.id),
    findAccountStanding(env.DB, account.id),
    loadCustomEmojis(env, identity.mediaPublicBaseUrl),
  ]);
  if (aliases.isErr()) {
    return err(aliases.error);
  }
  if (move.isErr()) {
    return err(move.error);
  }
  if (profile.isErr()) {
    return err(profile.error);
  }
  if (standing.isErr()) {
    return err(standing.error);
  }
  const { note, fields } = profile.value;
  const shown: ActorProfile =
    standing.value.kind === "Suspended"
      ? { kind: "Suspended" }
      : {
          kind: "Shown",
          profile: profile.value,
          emojis: emojisInTexts(
            [account.displayName, note, ...fields.flatMap((field) => [field.name, field.value])],
            emojis,
          ),
        };
  return ok(
    actorDocument(
      identity,
      account,
      {
        alsoKnownAs: aliases.value.map((alias) => alias.actorUri),
        movedTo: move.value?.targetUri,
      },
      shown,
    ),
  );
};

/**
 * Tell remote followers the actor changed: an `Update` carrying the current
 * actor document, which remote servers use to refresh their cached copy (its
 * name, bio, avatar, header, fields and flags as well as a move).
 */
export const sendActorUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const document = await localActorDocument(env, identity, account);
  if (document.isErr()) {
    return err(document.error);
  }
  const actor = InstanceIdentity.actorUrl(identity, account.username);
  // As Mastodon's `UpdateSerializer`: the actor's context on the activity,
  // addressed to the public.
  const { "@context": context, ...object } = document.value;
  return enqueueLocalActivity(env, account.id, "Update", {
    "@context": context,
    id: `${actor}#updates/${newEntityId()}`,
    type: "Update",
    actor,
    published: nowIso(),
    to: [PUBLIC_COLLECTION],
    object,
  });
};
