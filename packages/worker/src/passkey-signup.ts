import { err, ok, type Result } from "neverthrow";
import { AccessEmail, type LocalAccount } from "@tstodon/domain";
import { findAccountByEmail, findAccountByUsername } from "./account-store";
import { provisionLocalAccount, signupUsername, type ProvisionError } from "./account-provision";
import { parseRow, runD1 } from "./d1";
import { escapeHtml } from "./html";
import {
  consumeSignupIntent as consumeSignupIntentSql,
  deleteSignupIntentsByEmail,
  findRecentSignupIntent,
  findSignupIntent as findSignupIntentSql,
  insertSignupIntent,
} from "./generated/prisma/sql";
import { sendEmail, type MailError } from "./mailer";
import { randomSecret, sha256Hex } from "./oauth-store";
import { isRegistrationBlocked } from "./registration-block-store";
import {
  parseInstanceIdentity,
  registrationApprovalRequired,
  registrationsOpen,
} from "./runtime-config";
import { queryTyped, runTypedBatch } from "./typed-sql";
import { z } from "zod";

/**
 * Sign-up in two steps. The form takes a username and an email address and
 * mails a one-time link; only that link opens the passkey step, whose
 * `context` is the link's token. Once the authenticator's response verifies,
 * the intent is consumed and the Better Auth user (with the verified email)
 * and the local account are created together.
 */

/** A sign-up link stays usable this long. */
const SIGNUP_LINK_TTL_MS = 60 * 60 * 1000;

/** One confirmation email per address per minute, so the form cannot flood an inbox. */
const SIGNUP_RESEND_INTERVAL_MS = 60 * 1000;

export type SignupError =
  | ProvisionError
  | MailError
  | Readonly<{ kind: "RegistrationsClosed" }>
  | Readonly<{ kind: "InvalidEmail" }>
  | Readonly<{ kind: "EmailTaken" }>
  | Readonly<{ kind: "InvalidSignupLink" }>;

/** Void hands the auth config the Worker's bindings untyped. */
export const isWorkerEnv = (env: unknown): env is Env =>
  typeof env === "object" &&
  env !== null &&
  "DB" in env &&
  typeof env.DB === "object" &&
  "INSTANCE_DOMAIN" in env &&
  typeof env.INSTANCE_DOMAIN === "string";

/** Shown on the sign-up pages; never names more than the problem. */
export const signupErrorMessage = (error: SignupError): string => {
  switch (error.kind) {
    case "RegistrationsClosed":
      return "This server is not accepting new accounts.";
    case "InvalidUsername":
      return "Usernames are 1 to 30 letters, digits, or underscores.";
    case "UsernameTaken":
      return "That username is taken.";
    case "InvalidEmail":
      return "Enter a valid email address.";
    case "EmailTaken":
      return "That email address already has an account.";
    case "RegistrationBlocked":
      return "This sign-up is not allowed.";
    case "InvalidSignupLink":
      return "This sign-up link is invalid or has expired. Start again.";
    case "MailError":
      return "The confirmation email could not be sent. Try again later.";
    case "RepositoryError":
      return "Sign-up failed. Try again.";
  }
};

export type SignupIntent = Readonly<{ username: string; email: string }>;

/** Whether `username` and `email` may still become a new account. */
const checkAvailable = async (
  env: Env,
  rawUsername: string,
  rawEmail: string,
): Promise<Result<SignupIntent, SignupError>> => {
  if (!registrationsOpen(env)) {
    return err({ kind: "RegistrationsClosed" });
  }
  const username = signupUsername(rawUsername);
  if (username.isErr()) {
    return err(username.error);
  }
  const email = AccessEmail.parse(rawEmail);
  if (email.isErr()) {
    return err({ kind: "InvalidEmail" });
  }
  const [taken, emailTaken, blocked] = await Promise.all([
    findAccountByUsername(env.DB, username.value),
    findAccountByEmail(env.DB, email.value),
    isRegistrationBlocked(env.DB, email.value),
  ]);
  if (taken.isErr()) {
    return err(taken.error);
  }
  if (taken.value) {
    return err({ kind: "UsernameTaken" });
  }
  if (emailTaken.isErr()) {
    return err(emailTaken.error);
  }
  if (emailTaken.value) {
    return err({ kind: "EmailTaken" });
  }
  if (blocked.isErr()) {
    return err(blocked.error);
  }
  if (blocked.value) {
    return err({ kind: "RegistrationBlocked" });
  }
  return ok({ username: username.value, email: email.value });
};

const signupMail = (instanceName: string, username: string, link: string) => ({
  subject: `Confirm your ${instanceName} account`,
  text: `Someone (hopefully you) asked to create the account @${username} on ${instanceName} with this email address.\n\nOpen this link within an hour to confirm the address and create your passkey:\n\n${link}\n\nIf this was not you, ignore this email.`,
  html: `<p>Someone (hopefully you) asked to create the account <strong>@${escapeHtml(username)}</strong> on ${escapeHtml(instanceName)} with this email address.</p>
<p><a href="${escapeHtml(link)}">Confirm the address and create your passkey</a> (valid for an hour).</p>
<p>If this was not you, ignore this email.</p>`,
});

/**
 * Step one: store an intent for `username` / `email` and mail its link. A
 * new request for the same address replaces the previous link.
 */
export const requestSignup = async (
  env: Env,
  rawUsername: string,
  rawEmail: string,
): Promise<Result<SignupIntent, SignupError>> => {
  const intent = await checkAvailable(env, rawUsername, rawEmail);
  if (intent.isErr()) {
    return intent;
  }
  const now = new Date();
  const recent = await runD1(() =>
    queryTyped(
      env.DB,
      findRecentSignupIntent(
        intent.value.email,
        new Date(now.getTime() - SIGNUP_RESEND_INTERVAL_MS).toISOString(),
      ),
    ),
  );
  if (recent.isErr()) {
    return err(recent.error);
  }
  if (recent.value.length > 0) {
    // The link from a moment ago is still on its way; do not send another.
    return ok(intent.value);
  }
  const token = randomSecret();
  const stored = await runTypedBatch(env.DB, [
    deleteSignupIntentsByEmail(intent.value.email, now.toISOString()),
    insertSignupIntent(
      await sha256Hex(token),
      intent.value.username,
      intent.value.email,
      new Date(now.getTime() + SIGNUP_LINK_TTL_MS).toISOString(),
      now.toISOString(),
    ),
  ]);
  if (stored.isErr()) {
    return err(stored.error);
  }
  const identity = parseInstanceIdentity(env);
  const origin = identity.isOk() ? identity.value.publicOrigin : `https://${env.INSTANCE_DOMAIN}`;
  const link = `${origin}/auth/sign_up/verify?${new URLSearchParams({ token }).toString()}`;
  const sent = await sendEmail(env, {
    to: intent.value.email,
    ...signupMail(env.INSTANCE_NAME || "tstodon", intent.value.username, link),
  });
  return sent.isErr() ? err(sent.error) : ok(intent.value);
};

const IntentRowSchema = z.object({
  username: z.string(),
  email: z.string(),
  expires_at: z.string(),
});

const liveIntent = (rows: ReadonlyArray<unknown>): Result<SignupIntent, SignupError> => {
  const raw = rows[0];
  if (raw === undefined) {
    return err({ kind: "InvalidSignupLink" });
  }
  const row = parseRow(IntentRowSchema, raw);
  if (row.isErr()) {
    return err(row.error);
  }
  if (Date.parse(row.value.expires_at) <= Date.now()) {
    return err({ kind: "InvalidSignupLink" });
  }
  return ok({ username: row.value.username, email: row.value.email });
};

/** Step two, before the passkey: the intent behind a link, if it can still sign up. */
export const checkSignupLink = async (
  env: Env,
  token: string | null | undefined,
): Promise<Result<SignupIntent, SignupError>> => {
  if (!token) {
    return err({ kind: "InvalidSignupLink" });
  }
  const hash = await sha256Hex(token);
  const rows = await runD1(() => queryTyped(env.DB, findSignupIntentSql(hash)));
  if (rows.isErr()) {
    return err(rows.error);
  }
  const intent = liveIntent(rows.value);
  return intent.isErr() ? intent : checkAvailable(env, intent.value.username, intent.value.email);
};

/** Step two, after the passkey verified: use the link up, once. */
export const consumeSignupLink = async (
  env: Env,
  token: string | null | undefined,
): Promise<Result<SignupIntent, SignupError>> => {
  if (!token) {
    return err({ kind: "InvalidSignupLink" });
  }
  const hash = await sha256Hex(token);
  const rows = await runD1(() => queryTyped(env.DB, consumeSignupIntentSql(hash)));
  if (rows.isErr()) {
    return err(rows.error);
  }
  const intent = liveIntent(rows.value);
  return intent.isErr() ? intent : checkAvailable(env, intent.value.username, intent.value.email);
};

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
  intent: SignupIntent,
  authUserId: string,
): Promise<Result<LocalAccount, ProvisionError>> =>
  provisionLocalAccount(env.DB, {
    username: intent.username,
    email: intent.email,
    authUserId,
    pending: registrationApprovalRequired(env),
  });
