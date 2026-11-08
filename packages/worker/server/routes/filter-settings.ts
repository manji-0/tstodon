import { warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import { errorPage } from "../auth-pages";
import {
  filterFormProblems,
  type FilterFormValues,
  KEEP_EXPIRY,
  keptKeywords,
  parseFilterForm,
} from "../filter-form";
import {
  type FilterFormMode,
  filterFormPage,
  type FilterListItem,
  filterNotFoundPage,
  filtersPage,
} from "../filter-pages";
import {
  deleteFilter,
  type FilterKeyword,
  filterKeywords,
  type FilterRow,
  findFilterById,
  insertFilter,
  listFilters,
  listFilterStatuses,
  removeFilterStatusById,
  updateFilter,
} from "../filter-store";
import { readOptionalBody } from "../http";
import { newEntityId } from "../ids";
import type { PageMessage } from "../settings-pages";
import { instanceName, type SettingsContext, settingsAccount } from "./account-settings";
import { expiresAtFromBody, storedContexts } from "./filters/shared";
import { pageRedirect } from "../page-redirect";

/**
 * Mastodon's filter pages: the list of filters (`/filters`) and the form that
 * creates and edits one. They read and write what `/api/v2/filters` does.
 */

const NOTICES = {
  created: "Filter created.",
  updated: "Changes saved.",
  deleted: "Filter deleted.",
} as const;

const FormFieldsSchema = z.record(z.string(), z.string());

const serverError = (c: SettingsContext, text: string) =>
  c.html(errorPage(instanceName(c.env), text), 500);

const notFound = (c: SettingsContext) => c.html(filterNotFoundPage(instanceName(c.env)), 404);

const redirectToList = (c: SettingsContext, notice: keyof typeof NOTICES) =>
  pageRedirect(c, `/filters?notice=${notice}`, 303);

const listItemOf = (row: FilterRow, statusCount: number): FilterListItem => ({
  id: row.id,
  title: row.phrase,
  contexts: storedContexts(row),
  action: row.irreversible === 1 ? "hide" : "warn",
  expiresAt: row.expires_at,
  keywordCount: filterKeywords(row).length,
  statusCount,
});

/** Mastodon's `GET /filters`. */
export const getFilters = async (c: Context<{ Bindings: Env }, "/filters">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const rows = await listFilters(c.env.DB, signedIn.account.id);
  if (rows.isErr()) {
    return serverError(c, "The server could not read your filters.");
  }
  const items: FilterListItem[] = [];
  for (const row of rows.value) {
    const statuses = await listFilterStatuses(c.env.DB, row.id);
    items.push(listItemOf(row, statuses.isOk() ? statuses.value.length : 0));
  }
  const notice = c.req.query("notice");
  const message: PageMessage | undefined =
    notice === "created" || notice === "updated" || notice === "deleted"
      ? { kind: "notice", text: NOTICES[notice] }
      : undefined;
  return c.html(filtersPage(instanceName(c.env), items, message));
};

const NEW_FILTER: FilterFormValues = {
  title: "",
  expires: "never",
  contexts: ["home"],
  action: "warn",
  keywords: [],
  removeStatusIds: [],
};

/** Mastodon's `GET /filters/new`. */
export const getNewFilter = async (c: Context<{ Bindings: Env }, "/filters/new">) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered"
    ? signedIn.response
    : c.html(filterFormPage(instanceName(c.env), { kind: "new" }, NEW_FILTER));
};

const formOf = (row: FilterRow): FilterFormValues => ({
  title: row.phrase,
  expires: row.expires_at === null ? "never" : KEEP_EXPIRY,
  contexts: storedContexts(row),
  action: row.irreversible === 1 ? "hide" : "warn",
  keywords: filterKeywords(row).map((keyword) => ({
    id: keyword.id,
    keyword: keyword.keyword,
    wholeWord: keyword.whole_word,
    remove: false,
  })),
  removeStatusIds: [],
});

const editMode = async (
  c: SettingsContext,
  row: FilterRow,
): Promise<FilterFormMode | undefined> => {
  const statuses = await listFilterStatuses(c.env.DB, row.id);
  return statuses.isErr()
    ? undefined
    : {
        kind: "edit",
        id: row.id,
        expiresAt: row.expires_at,
        statuses: statuses.value.map((entry) => ({ id: entry.id, statusId: entry.status_id })),
      };
};

/** Mastodon's `GET /filters/:id/edit`. */
export const getEditFilter = async (c: Context<{ Bindings: Env }, "/filters/:id/edit">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const row = await findFilterById(c.env.DB, signedIn.account.id, c.req.param("id"));
  if (row.isErr()) {
    return serverError(c, "The server could not read your filter.");
  }
  if (row.value === undefined) {
    return notFound(c);
  }
  const mode = await editMode(c, row.value);
  return mode === undefined
    ? serverError(c, "The server could not read your filter.")
    : c.html(filterFormPage(instanceName(c.env), mode, formOf(row.value)));
};

const readForm = async (c: SettingsContext): Promise<FilterFormValues> => {
  const fields = await readOptionalBody(c, FormFieldsSchema);
  return parseFilterForm(fields.isOk() ? fields.value : {});
};

const invalid = (
  c: SettingsContext,
  mode: FilterFormMode,
  values: FilterFormValues,
  problems: ReadonlyArray<string>,
) =>
  c.html(
    filterFormPage(instanceName(c.env), mode, values, {
      kind: "error",
      text: problems.join(" "),
    }),
    422,
  );

const keywordsOf = (
  values: FilterFormValues,
  existing: ReadonlyArray<FilterKeyword>,
): FilterKeyword[] => {
  const known = new Set(existing.map((keyword) => keyword.id));
  return keptKeywords(values).map((row) => ({
    id: known.has(row.id) ? row.id : newEntityId(),
    keyword: row.keyword,
    whole_word: row.wholeWord,
  }));
};

/** Mastodon's `POST /filters`. */
export const postCreateFilter = async (c: Context<{ Bindings: Env }, "/filters">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const values = await readForm(c);
  const mode: FilterFormMode = { kind: "new" };
  const problems = filterFormProblems(values, { canKeepExpiry: false });
  if (problems.length > 0) {
    return invalid(c, mode, values, problems);
  }
  const keywords = keywordsOf(values, []);
  const created = await insertFilter(c.env.DB, {
    accountId: signedIn.account.id,
    phrase: values.title,
    context: values.contexts,
    wholeWord: keywords[0]?.whole_word ?? false,
    irreversible: values.action === "hide",
    expiresAt: expiresAtFromBody(values.expires) ?? undefined,
    keywords,
  });
  return created.isErr()
    ? c.html(
        filterFormPage(instanceName(c.env), mode, values, {
          kind: "error",
          text: "The server could not save the filter. Try again.",
        }),
        500,
      )
    : redirectToList(c, "created");
};

/** Mastodon's `PUT /filters/:id`, as a form post. */
export const postEditFilter = async (c: Context<{ Bindings: Env }, "/filters/:id/edit">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const accountId = signedIn.account.id;
  const id = c.req.param("id");
  const existing = await findFilterById(c.env.DB, accountId, id);
  if (existing.isErr()) {
    return serverError(c, "The server could not read your filter.");
  }
  if (existing.value === undefined) {
    return notFound(c);
  }
  const row = existing.value;
  const mode = await editMode(c, row);
  if (mode === undefined) {
    return serverError(c, "The server could not read your filter.");
  }
  const values = await readForm(c);
  const problems = filterFormProblems(values, { canKeepExpiry: true });
  if (problems.length > 0) {
    return invalid(c, mode, values, problems);
  }
  const keywords = keywordsOf(values, filterKeywords(row));
  const updated = await updateFilter(c.env.DB, accountId, id, {
    phrase: values.title,
    context: values.contexts,
    wholeWord: keywords[0]?.whole_word ?? false,
    irreversible: values.action === "hide",
    expiresAt: values.expires === KEEP_EXPIRY ? row.expires_at : expiresAtFromBody(values.expires),
    keywords,
  });
  const dropped = await Promise.all(
    values.removeStatusIds.map((statusId) => removeFilterStatusById(c.env.DB, accountId, statusId)),
  );
  return updated.isErr() || dropped.some((result) => result.isErr())
    ? c.html(
        filterFormPage(instanceName(c.env), mode, values, {
          kind: "error",
          text: "The server could not save the filter. Try again.",
        }),
        500,
      )
    : redirectToList(c, "updated");
};

/** Mastodon's `DELETE /filters/:id`, as a form post. */
export const postDeleteFilter = async (c: Context<{ Bindings: Env }, "/filters/:id/delete">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const deleted = await deleteFilter(c.env.DB, signedIn.account.id, c.req.param("id"));
  if (deleted.isErr()) {
    return serverError(c, "The server could not delete the filter.");
  }
  return deleted.value ? redirectToList(c, "deleted") : notFound(c);
};

warmSchemas([FormFieldsSchema]);
