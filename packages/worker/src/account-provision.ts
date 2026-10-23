import { AccessEmail, AccountId, LocalAccount, Registration, Username } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { markAccountPending } from "./account-flag-store";
import { isRegistrationBlocked } from "./registration-block-store";
import { nowInstant } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { generateAccountKeys } from "./keys";
import { newEntityId } from "./ids";
import { findAccountByUsername, insertAccount } from "./account-store";
import { setAccountAuthUser } from "./generated/prisma/sql";
import { runTyped } from "./typed-sql";

/** Mastodon caps local usernames at 30 characters. */
export const MAX_USERNAME_LENGTH = 30;

export type ProvisionError =
  | RepositoryError
  | Readonly<{ kind: "InvalidUsername" }>
  | Readonly<{ kind: "UsernameTaken" }>
  /** A sign-up block refuses the new account without touching existing ones. */
  | Readonly<{ kind: "RegistrationBlocked" }>;

/** A sign-up username: valid characters, within the length cap. */
export const signupUsername = (raw: string): Result<Username, ProvisionError> => {
  const username = Username.parse(raw);
  if (username.isErr() || username.value.length > MAX_USERNAME_LENGTH) {
    return err({ kind: "InvalidUsername" });
  }
  return ok(username.value);
};

/**
 * Create the local account `username` for the Better Auth user `authUserId`.
 * `email` is the sign-in identity the account records (Better Auth's, which
 * for passkey sign-ups is synthesized from the username).
 */
export const provisionLocalAccount = async (
  db: D1Database,
  input: Readonly<{
    username: string;
    email: string;
    authUserId: string;
    /** With `REGISTRATION_APPROVAL` a brand-new account waits for an admin. */
    pending: boolean;
  }>,
): Promise<Result<LocalAccount, ProvisionError>> => {
  const username = signupUsername(input.username);
  if (username.isErr()) {
    return err(username.error);
  }
  const email = AccessEmail.parse(input.email);
  if (email.isErr()) {
    return err({ kind: "RepositoryError", message: "invalid email" });
  }
  const [taken, blocked] = await Promise.all([
    findAccountByUsername(db, username.value),
    isRegistrationBlocked(db, email.value),
  ]);
  if (taken.isErr()) {
    return err(taken.error);
  }
  if (taken.value) {
    return err({ kind: "UsernameTaken" });
  }
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
    // The unique index settles a race between two sign-ups for one name.
    const raced = await findAccountByUsername(db, username.value);
    return err(raced.isOk() && raced.value ? { kind: "UsernameTaken" } : inserted.error);
  }
  const linked = await runD1(() => runTyped(db, setAccountAuthUser(account.id, input.authUserId)));
  if (linked.isErr()) {
    return err(linked.error);
  }
  if (input.pending) {
    // Registrations that need approval start unsearchable until an admin acts.
    const marked = await markAccountPending(db, account.id);
    if (marked.isErr()) {
      return err(marked.error);
    }
  }
  return ok(account);
};
