import { InstanceIdentity, type LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { listAccountAliases } from "./account-alias-store";
import { findAccountMove } from "./account-move-store";
import { actorDocument } from "./activitypub";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { enqueueLocalActivity, type EnqueueLocalActivityError } from "./delivery";
import { newEntityId } from "./ids";

/**
 * The actor document of a local account as it stands now: with the accounts
 * it moved from (`alsoKnownAs`) and, while a move stands, the account it moved
 * to (`movedTo`).
 */
export const localActorDocument = async (
  db: D1Database,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Result<Record<string, unknown>, RepositoryError>> => {
  const [aliases, move] = await Promise.all([
    listAccountAliases(db, account.id),
    findAccountMove(db, account.id),
  ]);
  if (aliases.isErr()) {
    return err(aliases.error);
  }
  if (move.isErr()) {
    return err(move.error);
  }
  return ok(
    actorDocument(identity, account, {
      alsoKnownAs: aliases.value.map((alias) => alias.actorUri),
      movedTo: move.value?.targetUri,
    }),
  );
};

/**
 * Tell remote followers the actor changed: an `Update` carrying the current
 * actor document, which remote servers use to refresh their cached copy.
 */
export const sendActorUpdate = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const document = await localActorDocument(env.DB, identity, account);
  if (document.isErr()) {
    return err(document.error);
  }
  const actor = InstanceIdentity.actorUrl(identity, account.username);
  return enqueueLocalActivity(env, account.id, "Update", {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actor}#updates/${newEntityId()}`,
    type: "Update",
    actor,
    published: nowIso(),
    object: document.value,
  });
};
