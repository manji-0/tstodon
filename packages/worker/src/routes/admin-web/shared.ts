import { warmSchemas } from "@tstodon/core";
import { FediRole } from "@tstodon/domain";
import { z } from "zod";
import { findAccountById } from "../../account-store";
import { type AccountLabel, adminNotFoundPage } from "../../admin-pages";
import { errorPage } from "../../auth-pages";
import type { RepositoryError } from "../../d1";
import { readOptionalBody } from "../../http";
import { RemoteAccountId } from "../../remote-account-id";
import { findRemoteActorByUri } from "../../remote-actor-store";
import type { PageMessage } from "../../settings-pages";
import { instanceName, type SettingsContext, settingsAccount } from "../account-settings";

/**
 * What the admin pages (reports, accounts, federation) share. Each page and
 * form post needs an admin's browser session: the same role `/api/v1/admin`
 * requires of a token.
 */

const NOTICES = {
  resolved: "Report resolved.",
  reopened: "Report reopened.",
  assigned: "Report assigned to you.",
  unassigned: "Report unassigned.",
  actioned: "Action taken and report resolved.",
  updated: "Account updated.",
  deleted: "Account deleted.",
  block_saved: "Domain block saved.",
  block_removed: "Domain block removed.",
} as const;

export type NoticeKey = keyof typeof NOTICES;

const isNoticeKey = (key: string): key is NoticeKey => Object.hasOwn(NOTICES, key);

export const noticeOf = (c: SettingsContext): PageMessage | undefined => {
  const key = c.req.query("notice") ?? "";
  return isNoticeKey(key) ? { kind: "notice", text: NOTICES[key] } : undefined;
};

export const withNotice = (path: string, notice: NoticeKey): string => `${path}?notice=${notice}`;

/** The signed-in admin, or the response that replaces the page. */
export const adminSession = async (c: SettingsContext) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Account" && !FediRole.isAdmin(signedIn.role)) {
    return {
      kind: "Answered",
      response: c.html(
        errorPage(instanceName(c.env), "This page is for the server's administrators."),
        403,
      ),
    } as const;
  }
  return signedIn;
};

export const serverError = (c: SettingsContext, error: RepositoryError) =>
  c.html(errorPage(instanceName(c.env), `The server could not do that: ${error.message}`), 500);

export const notFound = (c: SettingsContext, what: string) =>
  c.html(adminNotFoundPage(instanceName(c.env), what), 404);

const FormFieldsSchema = z.record(z.string(), z.string());

export const readFields = async (c: SettingsContext): Promise<Readonly<Record<string, string>>> => {
  const fields = await readOptionalBody(c, FormFieldsSchema);
  return fields.isOk() ? fields.value : {};
};

export const remoteDomain = (actorUri: string): string | undefined =>
  URL.canParse(actorUri) ? new URL(actorUri).host : undefined;

/**
 * Names accounts for a page, reading each one once. A remote actor is named by
 * its cached handle, else by the `acct` a report kept of it.
 */
export const accountLabeller = (db: D1Database) => {
  const known = new Map<string, Promise<AccountLabel>>();
  const lookUp = async (id: string, acct: string | null): Promise<AccountLabel> => {
    const remote = RemoteAccountId.decode(id);
    if (remote.isOk()) {
      const actor = await findRemoteActorByUri(db, remote.value);
      const handle =
        actor.isOk() && actor.value ? `${actor.value.username}@${actor.value.domain}` : acct;
      return {
        label: handle === null ? remote.value : `@${handle}`,
        href: `/admin/accounts/${id}`,
      };
    }
    const account = await findAccountById(db, id);
    return account.isOk() && account.value
      ? { label: `@${account.value.username}`, href: `/admin/accounts/${id}` }
      : { label: `account ${id}`, href: undefined };
  };
  return (id: string, acct: string | null = null): Promise<AccountLabel> => {
    const label = known.get(id) ?? lookUp(id, acct);
    known.set(id, label);
    return label;
  };
};

export const badForm = (c: SettingsContext) =>
  c.html(
    errorPage(instanceName(c.env), "The form was not understood. Go back and try again."),
    422,
  );

warmSchemas([FormFieldsSchema]);
