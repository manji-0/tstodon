import { InstanceIdentity, type LocalAccount } from "@tstodon/domain";
import { err, type Result } from "neverthrow";
import { addAccountAlias } from "./account-alias-store";
import { refAcct, resolveAccountHandle, type ResolveHandleError } from "./account-ref";

export type AddAliasError = ResolveHandleError | Readonly<{ kind: "SelfAlias" }>;

/**
 * Record that `account` moved from the account `handle` names, as Mastodon's
 * `AccountAlias`: the handle must resolve, and it must not be the account itself.
 */
export const addAlias = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  handle: string,
): Promise<Result<void, AddAliasError>> => {
  const old = await resolveAccountHandle(env, identity, handle);
  if (old.isErr()) {
    return err(old.error);
  }
  if (old.value.actorUri === InstanceIdentity.actorUrl(identity, account.username)) {
    return err({ kind: "SelfAlias" });
  }
  return addAccountAlias(env.DB, account.id, {
    acct: refAcct(old.value),
    actorUri: old.value.actorUri,
  });
};
