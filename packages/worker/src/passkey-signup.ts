import { err, ok, type Result } from "neverthrow";
import type { LocalAccount } from "@tstodon/domain";
import { findAccountByUsername } from "./account-store";
import { provisionLocalAccount, signupUsername, type ProvisionError } from "./account-provision";
import { registrationApprovalRequired, registrationsOpen } from "./runtime-config";

/**
 * Passkey-first sign-up. The sign-up page asks Better Auth for registration
 * options with the wanted username as the passkey `context`; once the
 * authenticator's response verifies, the Better Auth user and the local
 * account are created together and the passkey is attached to that user.
 */

export type SignupError = ProvisionError | Readonly<{ kind: "RegistrationsClosed" }>;

/** Void hands the auth config the Worker's bindings untyped. */
export const isWorkerEnv = (env: unknown): env is Env =>
  typeof env === "object" &&
  env !== null &&
  "DB" in env &&
  typeof env.DB === "object" &&
  "INSTANCE_DOMAIN" in env &&
  typeof env.INSTANCE_DOMAIN === "string";

/** Shown on the sign-up page; never names more than the problem. */
export const signupErrorMessage = (error: SignupError): string => {
  switch (error.kind) {
    case "RegistrationsClosed":
      return "This server is not accepting new accounts.";
    case "InvalidUsername":
      return "Usernames are 1 to 30 letters, digits, or underscores.";
    case "UsernameTaken":
      return "That username is taken.";
    case "RegistrationBlocked":
      return "This sign-up is not allowed.";
    case "RepositoryError":
      return "Sign-up failed. Try again.";
  }
};

/** The username a sign-up may still claim. */
export const checkSignup = async (
  env: Env,
  rawUsername: string | null | undefined,
): Promise<Result<string, SignupError>> => {
  if (!registrationsOpen(env)) {
    return err({ kind: "RegistrationsClosed" });
  }
  const username = signupUsername(rawUsername ?? "");
  if (username.isErr()) {
    return err(username.error);
  }
  const taken = await findAccountByUsername(env.DB, username.value);
  if (taken.isErr()) {
    return err(taken.error);
  }
  return taken.value ? err({ kind: "UsernameTaken" }) : ok(username.value);
};

/**
 * Better Auth requires an email; a passkey account has none, so it gets
 * `username@host`, which is unique because the username is.
 */
export const signupEmail = (env: Env, username: string): string =>
  `${username}@${env.INSTANCE_DOMAIN.replace(/:\d+$/, "")}`.toLowerCase();

/** `ADMIN_USERNAMES` bootstraps admins: those names sign up as admins. */
export const signupRole = (env: Env, username: string): "admin" | "user" =>
  `${env.ADMIN_USERNAMES ?? ""}`
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .includes(username)
    ? "admin"
    : "user";

export const createSignupAccount = (
  env: Env,
  username: string,
  authUserId: string,
): Promise<Result<LocalAccount, ProvisionError>> =>
  provisionLocalAccount(env.DB, {
    username,
    email: signupEmail(env, username),
    authUserId,
    pending: registrationApprovalRequired(env),
  });
