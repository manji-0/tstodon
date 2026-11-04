import { Languages, warmSchemas } from "@tstodon/core";
import { FediRole, QuoteApprovalPolicy, Visibility } from "@tstodon/domain";
import type { Context } from "hono";
import { z } from "zod";
import { findComposeDefaults, updateAccountDefaults } from "../account-defaults-store";
import { findAccountProfile, upsertAccountProfile } from "../account-profile-store";
import { findAccountById, setAccountLocked } from "../account-store";
import { errorPage } from "../auth-pages";
import { readOptionalBody } from "../http";
import { quotePolicyName } from "../quote-policy-name";
import {
  type PageMessage,
  postingDefaultsPage,
  privacyPage,
  settingsIndexPage,
} from "../settings-pages";
import { instanceName, type SettingsContext, settingsAccount } from "./account-settings";

/**
 * The settings Mastodon's web app opens as Rails pages: the index it calls
 * "Preferences", posting defaults, and privacy and reach. They read and
 * write what `update_credentials` does.
 */

/** `/settings`: Mastodon sends it on to the first settings page. */
export const getSettings = (c: Context<{ Bindings: Env }, "/settings">) =>
  c.redirect("/settings/preferences");

/** `/settings/profile`: the web app edits the profile itself. */
export const getSettingsProfile = (c: Context<{ Bindings: Env }, "/settings/profile">) =>
  c.redirect("/profile/edit");

/** `/settings/preferences`: an index of the settings this server has. */
export const getSettingsPreferences = async (
  c: Context<{ Bindings: Env }, "/settings/preferences">,
) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered"
    ? signedIn.response
    : c.html(
        settingsIndexPage(
          instanceName(c.env),
          signedIn.account.username,
          FediRole.isAdmin(signedIn.role),
        ),
      );
};

const QUOTE_POLICIES = {
  public: QuoteApprovalPolicy.Public,
  followers: QuoteApprovalPolicy.Followers,
  nobody: QuoteApprovalPolicy.Nobody,
} as const;

const LANGUAGE_CODES: ReadonlySet<string> = new Set(Languages.map(([code]) => code));

const PostingDefaultsFormSchema = z.object({
  privacy: z.string().default(""),
  quote_policy: z.union([z.literal("public"), z.literal("followers"), z.literal("nobody")]),
  language: z
    .string()
    .trim()
    .default("")
    .refine((code) => code === "" || LANGUAGE_CODES.has(code)),
  sensitive: z.literal("1").optional(),
});

const renderPostingDefaults = async (
  c: SettingsContext,
  accountId: string,
  message?: PageMessage,
  status: 200 | 422 | 500 = 200,
) => {
  const [account, defaults] = await Promise.all([
    findAccountById(c.env.DB, accountId),
    findComposeDefaults(c.env.DB, accountId),
  ]);
  if (account.isErr() || account.value === undefined || defaults.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not read your settings."), 500);
  }
  return c.html(
    postingDefaultsPage(
      instanceName(c.env),
      {
        privacy: Visibility.toMastodon(account.value.defaultPostVisibility),
        quotePolicy: quotePolicyName(account.value.defaultQuotePolicy),
        sensitive: defaults.value.sensitive,
        language: defaults.value.language ?? "",
      },
      message,
    ),
    status,
  );
};

/** Mastodon's `GET /settings/preferences/posting_defaults`. */
export const getPostingDefaults = async (
  c: Context<{ Bindings: Env }, "/settings/preferences/posting_defaults">,
) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered"
    ? signedIn.response
    : renderPostingDefaults(c, signedIn.account.id);
};

/** Mastodon's `PUT /settings/preferences/posting_defaults`, as a form post. */
export const postPostingDefaults = async (
  c: Context<{ Bindings: Env }, "/settings/preferences/posting_defaults">,
) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const accountId = signedIn.account.id;
  const form = await readOptionalBody(c, PostingDefaultsFormSchema);
  const visibility = form.isOk() ? Visibility.fromMastodon(form.value.privacy) : undefined;
  if (!form.isOk() || visibility === undefined || visibility.isErr()) {
    return renderPostingDefaults(
      c,
      accountId,
      {
        kind: "error",
        text: "Choose a visibility, a quote setting, and a language from the lists.",
      },
      422,
    );
  }
  const saved = await updateAccountDefaults(c.env.DB, accountId, {
    visibility: visibility.value,
    quotePolicy: QUOTE_POLICIES[form.value.quote_policy],
    language: form.value.language === "" ? null : form.value.language,
    sensitive: form.value.sensitive !== undefined,
  });
  return saved.isErr()
    ? renderPostingDefaults(
        c,
        accountId,
        { kind: "error", text: "The server could not save your settings. Try again." },
        500,
      )
    : renderPostingDefaults(c, accountId, { kind: "notice", text: "Changes saved." });
};

/** Checkboxes post `1` when checked and nothing when not. */
const PrivacyFormSchema = z.object({
  account_unlocked: z.literal("1").optional(),
  account_discoverable: z.literal("1").optional(),
  account_indexable: z.literal("1").optional(),
  account_show_collections: z.literal("1").optional(),
});

const renderPrivacy = async (
  c: SettingsContext,
  accountId: string,
  message?: PageMessage,
  status: 200 | 422 | 500 = 200,
) => {
  const [account, profile] = await Promise.all([
    findAccountById(c.env.DB, accountId),
    findAccountProfile(c.env.DB, accountId),
  ]);
  if (account.isErr() || account.value === undefined || profile.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not read your settings."), 500);
  }
  return c.html(
    privacyPage(
      instanceName(c.env),
      {
        locked: account.value.locked,
        discoverable: profile.value.discoverable,
        indexable: profile.value.indexable,
        hideCollections: profile.value.hideCollections,
      },
      message,
    ),
    status,
  );
};

/** Mastodon's `GET /settings/privacy`. */
export const getSettingsPrivacy = async (c: Context<{ Bindings: Env }, "/settings/privacy">) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered" ? signedIn.response : renderPrivacy(c, signedIn.account.id);
};

/** Mastodon's `PUT /settings/privacy`, as a form post. */
export const postSettingsPrivacy = async (c: Context<{ Bindings: Env }, "/settings/privacy">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const accountId = signedIn.account.id;
  const form = await readOptionalBody(c, PrivacyFormSchema);
  if (form.isErr()) {
    return renderPrivacy(c, accountId, { kind: "error", text: "The form was not valid." }, 422);
  }
  const saveFailed = () =>
    renderPrivacy(
      c,
      accountId,
      { kind: "error", text: "The server could not save your settings. Try again." },
      500,
    );
  const profile = await findAccountProfile(c.env.DB, accountId);
  if (profile.isErr()) {
    return saveFailed();
  }
  const savedProfile = await upsertAccountProfile(c.env.DB, accountId, {
    ...profile.value,
    discoverable: form.value.account_discoverable !== undefined,
    indexable: form.value.account_indexable !== undefined,
    hideCollections: form.value.account_show_collections === undefined,
  });
  if (savedProfile.isErr()) {
    return saveFailed();
  }
  const locked = await setAccountLocked(
    c.env.DB,
    accountId,
    form.value.account_unlocked === undefined,
  );
  return locked.isErr()
    ? saveFailed()
    : renderPrivacy(c, accountId, { kind: "notice", text: "Changes saved." });
};

warmSchemas([PostingDefaultsFormSchema, PrivacyFormSchema]);
