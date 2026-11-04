import type { LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { z } from "zod";
import { warmSchemas } from "@tstodon/core";
import { listAccountAliases, removeAccountAlias } from "../account-alias-store";
import {
  addAlias,
  type AddAliasError,
  moveAccount,
  type MoveAccountError,
  nextMoveAt,
} from "../account-migration";
import { findAccountMove } from "../account-move-store";
import { errorPage } from "../auth-pages";
import { type BrowserSession, browserSession, isSameOriginPost } from "../browser-session";
import { readOptionalBody } from "../http";
import { parseInstanceIdentity } from "../runtime-config";
import { aliasesPage, migrationPage, type PageMessage } from "../settings-pages";

export const instanceName = (env: Env): string => env.INSTANCE_NAME || "tstodon";

export type SettingsContext = Context<{ Bindings: Env }>;

/**
 * The signed-in account for a settings page, or the response that replaces
 * the page: sign-in for a signed-out browser, an error for anyone else.
 */
export const settingsAccount = async (
  c: SettingsContext,
): Promise<
  Extract<BrowserSession, { kind: "Account" }> | Readonly<{ kind: "Answered"; response: Response }>
> => {
  if (c.req.method !== "GET" && !isSameOriginPost(c)) {
    return {
      kind: "Answered",
      response: c.html(
        errorPage(instanceName(c.env), "Settings must be changed on this site."),
        403,
      ),
    };
  }
  const session = await browserSession(c.env);
  switch (session.kind) {
    case "Account":
      return session;
    case "SignedOut":
      return {
        kind: "Answered",
        response: c.redirect(
          `/auth/sign_in?return_to=${encodeURIComponent(new URL(c.req.url).pathname)}`,
        ),
      };
    case "NoAccount":
    case "Barred":
      return {
        kind: "Answered",
        response: c.html(
          errorPage(instanceName(c.env), "This sign-in has no account that can change settings."),
          403,
        ),
      };
  }
};

const aliasErrorMessage = (error: AddAliasError): string => {
  switch (error.kind) {
    case "InvalidHandle":
      return "Enter a handle like username@domain.";
    case "AccountNotFound":
      return "No account was found for that handle.";
    case "SelfAlias":
      return "You cannot add your own account as an alias.";
    case "RepositoryError":
      return "The server could not save the alias. Try again.";
  }
};

const renderAliases = async (
  c: SettingsContext,
  account: LocalAccount,
  message?: PageMessage,
  status: 200 | 422 | 500 = 200,
) => {
  const aliases = await listAccountAliases(c.env.DB, account.id);
  if (aliases.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not read your aliases."), 500);
  }
  return c.html(aliasesPage(instanceName(c.env), account.username, aliases.value, message), status);
};

/** Mastodon's `GET /settings/aliases`. */
export const getSettingsAliases = async (c: Context<{ Bindings: Env }, "/settings/aliases">) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered" ? signedIn.response : renderAliases(c, signedIn.account);
};

const AliasFormSchema = z.object({ acct: z.string().trim().default("") });

/** Mastodon's `POST /settings/aliases`: add an account this one moved from. */
export const postSettingsAliases = async (c: Context<{ Bindings: Env }, "/settings/aliases">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  const form = await readOptionalBody(c, AliasFormSchema);
  const added = await addAlias(
    c.env,
    identity.value,
    signedIn.account,
    form.isOk() ? form.value.acct : "",
  );
  if (added.isErr()) {
    return renderAliases(
      c,
      signedIn.account,
      { kind: "error", text: aliasErrorMessage(added.error) },
      added.error.kind === "RepositoryError" ? 500 : 422,
    );
  }
  return renderAliases(c, signedIn.account, { kind: "notice", text: "Alias created." });
};

const RemoveAliasFormSchema = z.object({ id: z.string().default("") });

/** Mastodon's `DELETE /settings/aliases/:id`, as a form post. */
export const postSettingsAliasesRemove = async (
  c: Context<{ Bindings: Env }, "/settings/aliases/remove">,
) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const form = await readOptionalBody(c, RemoveAliasFormSchema);
  const removed = await removeAccountAlias(
    c.env.DB,
    signedIn.account.id,
    form.isOk() ? form.value.id : "",
  );
  if (removed.isErr()) {
    return renderAliases(
      c,
      signedIn.account,
      { kind: "error", text: "The server could not remove the alias. Try again." },
      500,
    );
  }
  return renderAliases(c, signedIn.account, { kind: "notice", text: "Alias removed." });
};

/**
 * How recent a sign-in must be to move the account. Mastodon asks for the
 * password again; a passkey sign-in on the page starts a fresh session.
 */
export const MOVE_REAUTH_WINDOW_MS = 10 * 60 * 1000;

const reauthRequired = (signedInAt: Date, now: number = Date.now()): boolean =>
  now - signedInAt.getTime() > MOVE_REAUTH_WINDOW_MS;

const moveErrorMessage = (error: MoveAccountError): string => {
  switch (error.kind) {
    case "InvalidHandle":
      return "Enter a handle like username@domain.";
    case "AccountNotFound":
      return "No account was found for that handle.";
    case "SelfMove":
      return "You cannot move to your own account.";
    case "TargetUnavailable":
      return "The new account could not be reached. Try again later.";
    case "MissingAlias":
      return 'The new account does not list this account as an alias yet. Add it there under "Moving from a different account" first.';
    case "OnCooldown":
      return `You moved recently. You can move again after ${error.until.toISOString()}.`;
    case "RepositoryError":
    case "InvalidActivityId":
    case "QueueSendFailed":
      return "The server could not complete the move. Try again.";
  }
};

const renderMigration = async (
  c: SettingsContext,
  account: LocalAccount,
  signedInAt: Date,
  message?: PageMessage,
  status: 200 | 403 | 422 | 500 = 200,
) => {
  const move = await findAccountMove(c.env.DB, account.id);
  if (move.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not read your account."), 500);
  }
  const next = move.value ? nextMoveAt(move.value) : undefined;
  return c.html(
    migrationPage(
      instanceName(c.env),
      account.username,
      {
        movedTo: move.value?.acct,
        nextMoveAt: next !== undefined && next.getTime() > Date.now() ? next : undefined,
        reauthRequired: reauthRequired(signedInAt),
      },
      message,
    ),
    status,
  );
};

/** Mastodon's `GET /settings/migration`. */
export const getSettingsMigration = async (
  c: Context<{ Bindings: Env }, "/settings/migration">,
) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered"
    ? signedIn.response
    : renderMigration(c, signedIn.account, signedIn.signedInAt);
};

const MigrationFormSchema = z.object({ acct: z.string().trim().default("") });

/** Mastodon's `POST /settings/migration`: move this account's followers to another account. */
export const postSettingsMigration = async (
  c: Context<{ Bindings: Env }, "/settings/migration">,
) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const { account, signedInAt } = signedIn;
  if (reauthRequired(signedInAt)) {
    return renderMigration(
      c,
      account,
      signedInAt,
      { kind: "error", text: "Confirm with your passkey to move your account." },
      403,
    );
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  const form = await readOptionalBody(c, MigrationFormSchema);
  const moved = await moveAccount(
    c.env,
    identity.value,
    account,
    form.isOk() ? form.value.acct : "",
  );
  if (moved.isErr()) {
    const failed =
      moved.error.kind === "RepositoryError" ||
      moved.error.kind === "InvalidActivityId" ||
      moved.error.kind === "QueueSendFailed";
    return renderMigration(
      c,
      account,
      signedInAt,
      { kind: "error", text: moveErrorMessage(moved.error) },
      failed ? 500 : 422,
    );
  }
  return renderMigration(c, account, signedInAt, {
    kind: "notice",
    text: `Your followers are moving to ${moved.value.acct}.`,
  });
};

warmSchemas([AliasFormSchema, RemoveAliasFormSchema, MigrationFormSchema]);
