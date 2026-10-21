import { AccessEmail, AccountId, LocalAccount, Registration, Username } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { markAccountPending } from "./account-flag-store";
import { isRegistrationBlocked } from "./registration-block-store";
import { nowInstant } from "./clock";
import type { RepositoryError } from "./d1";
import { generateAccountKeys } from "./keys";
import { newEntityId } from "./ids";
import { findAccountByEmail, findAccountByUsername, insertAccount } from "./account-store";

/** A sign-up block refuses the new account without touching existing ones. */
export type ProvisionError = RepositoryError | Readonly<{ kind: "RegistrationBlocked" }>;

export const provisionAccountFromEmail = async (
  db: D1Database,
  rawEmail: string,
  options: Readonly<{ pending?: boolean }> = {},
): Promise<Result<LocalAccount, ProvisionError>> => {
  const existing = await findAccountByEmail(db, rawEmail);
  if (existing.isErr()) {
    return err(existing.error);
  }
  if (existing.value) {
    return ok(existing.value);
  }
  const email = AccessEmail.parse(rawEmail);
  if (email.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid email" });
  }
  const baseUsername = Username.deriveFromEmail(email.value, false);
  if (baseUsername.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid username" });
  }
  const taken = await findAccountByUsername(db, baseUsername.value);
  if (taken.isErr()) {
    return err(taken.error);
  }
  const username = taken.value
    ? Username.deriveFromEmail(email.value, true)
    : ok(baseUsername.value);
  if (username.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid username" });
  }
  const blocked = await isRegistrationBlocked(db, email.value);
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (blocked.value) {
    return err({ kind: "RegistrationBlocked" });
  }
  const keys = await generateAccountKeys();
  const id = AccountId.parse(newEntityId());
  if (id.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid id" });
  }
  const registering = Registration.register(
    { kind: "IntentValidated", username: username.value, email: email.value },
    id.value,
    keys,
  );
  const account = LocalAccount.provision(registering, nowInstant());
  const inserted = await insertAccount(db, account);
  if (inserted.isErr()) {
    return err(inserted.error);
  }
  if (options.pending) {
    // Registrations that need approval start unsearchable until an admin acts.
    const marked = await markAccountPending(db, account.id);
    if (marked.isErr()) {
      return err(marked.error);
    }
  }
  return ok(account);
};
