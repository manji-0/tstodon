import type { LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { z } from "zod";
import { warmSchemas } from "@tstodon/core";
import { listAccountAliases, removeAccountAlias } from "../account-alias-store";
import { addAlias, type AddAliasError } from "../account-migration";
import { errorPage } from "../auth-pages";
import { browserSession, isSameOriginPost } from "../browser-session";
import { readOptionalBody } from "../http";
import { parseInstanceIdentity } from "../runtime-config";
import { aliasesPage } from "../settings-pages";

const instanceName = (env: Env): string => env.INSTANCE_NAME || "tstodon";

type SettingsContext = Context<{ Bindings: Env }>;

/**
 * The signed-in account for a settings page, or the response that replaces
 * the page: sign-in for a signed-out browser, an error for anyone else.
 */
const settingsAccount = async (
  c: SettingsContext,
): Promise<
  | Readonly<{ kind: "Account"; account: LocalAccount; signedInAt: Date }>
  | Readonly<{ kind: "Answered"; response: Response }>
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
  message?: Readonly<{ kind: "error" | "notice"; text: string }>,
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

warmSchemas([AliasFormSchema, RemoveAliasFormSchema]);
