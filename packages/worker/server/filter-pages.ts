import { page } from "./auth-pages";
import {
  FILTER_CONTEXTS,
  FILTER_EXPIRY_CHOICES,
  type FilterFormValues,
  KEEP_EXPIRY,
  type KeywordRow,
} from "./filter-form";
import { escapeHtml } from "./html";
import { checkbox, messageLine, nav, options, type PageMessage } from "./settings-pages";

/**
 * Mastodon's filter pages (`/filters`, `/filters/new`, `/filters/:id/edit`),
 * in the style of the other settings pages. They edit the same filters as
 * `/api/v2/filters`.
 */

export type FilterListItem = Readonly<{
  id: string;
  title: string;
  contexts: ReadonlyArray<string>;
  action: "warn" | "hide";
  expiresAt: string | null;
  keywordCount: number;
  statusCount: number;
}>;

const contextLabel = (context: string): string =>
  FILTER_CONTEXTS.find(([name]) => name === context)?.[1] ?? context;

const ACTION_LABELS = { warn: "Hide behind a warning", hide: "Hide completely" } as const;

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

const listItem = (item: FilterListItem, now: Date): string => {
  const id = escapeHtml(item.id);
  const expiry =
    item.expiresAt === null
      ? "never expires"
      : `${new Date(item.expiresAt) <= now ? "expired" : "expires"} ${escapeHtml(item.expiresAt)}`;
  return `
        <li>
          <strong>${escapeHtml(item.title)}</strong>
          <span class="muted">${escapeHtml(item.contexts.map(contextLabel).join(", "))} · ${ACTION_LABELS[item.action].toLowerCase()} · ${expiry} · ${count(item.keywordCount, "keyword")}${item.statusCount > 0 ? ` · ${count(item.statusCount, "post")}` : ""}</span>
          <a href="/filters/${id}/edit">Edit</a>
          <form method="post" action="/filters/${id}/delete">
            <button type="submit">Delete</button>
          </form>
        </li>`;
};

/** Mastodon's `GET /filters`. */
export const filtersPage = (
  instanceName: string,
  items: ReadonlyArray<FilterListItem>,
  message?: PageMessage,
  now: Date = new Date(),
): string =>
  page(
    `Muted words · ${instanceName}`,
    `${nav}
      <h1>Muted words</h1>
      <p>Filters hide posts that contain certain words, or individual posts, from the places you choose.</p>
      <p><a href="/filters/new">Add new filter</a></p>
${messageLine(message)}${
      items.length === 0
        ? `
      <p class="muted">You have no filters yet.</p>`
        : `
      <ul>${items.map((item) => listItem(item, now)).join("")}
      </ul>`
    }`,
  );

export type FilterFormMode =
  | Readonly<{ kind: "new" }>
  | Readonly<{
      kind: "edit";
      id: string;
      expiresAt: string | null;
      /** FilterStatus ids with the post each one hides. */
      statuses: ReadonlyArray<Readonly<{ id: string; statusId: string }>>;
    }>;

const BLANK_ROWS = 3;

const blankRow: KeywordRow = { id: "", keyword: "", wholeWord: false, remove: false };

const keywordRows = (rows: ReadonlyArray<KeywordRow>): string =>
  [
    ...rows.filter((row) => row.id !== "" || row.keyword !== ""),
    ...Array.from({ length: BLANK_ROWS }, (): KeywordRow => blankRow),
  ]
    .map((row, index) => {
      const name = `keyword_${index}`;
      return `
        <div class="keyword">
          <label for="${name}">Keyword or phrase</label>
          <input id="${name}" name="${name}" maxlength="256" autocomplete="off" value="${escapeHtml(row.keyword)}" />
          <input type="hidden" name="${name}_id" value="${escapeHtml(row.id)}" />
          ${checkbox(`${name}_whole_word`, row.wholeWord, "Whole word", "Only match the full word.")}${
            row.id === ""
              ? ""
              : `\n          ${checkbox(`${name}_remove`, row.remove, "Remove", "Delete this keyword on save.")}`
          }
        </div>`;
    })
    .join("");

const statusRows = (mode: FilterFormMode, removed: ReadonlyArray<string>): string =>
  mode.kind === "edit" && mode.statuses.length > 0
    ? `
        <h2>Individual posts</h2>
        <p class="muted">These posts are filtered whatever they say.</p>${mode.statuses
          .map((entry) =>
            checkbox(
              `remove_status_${entry.id}`,
              removed.includes(entry.id),
              `Remove post ${entry.statusId}`,
              "Stop filtering it on save.",
            ),
          )
          .join("")}`
    : "";

/** Mastodon's `GET /filters/new` and `GET /filters/:id/edit`. */
export const filterFormPage = (
  instanceName: string,
  mode: FilterFormMode,
  values: FilterFormValues,
  message?: PageMessage,
): string => {
  const keepExpiry =
    mode.kind === "edit" && mode.expiresAt !== null
      ? ([[KEEP_EXPIRY, `Keep (expires ${mode.expiresAt})`]] as const)
      : ([] as const);
  const title = mode.kind === "new" ? "New filter" : "Edit filter";
  return page(
    `${title} · ${instanceName}`,
    `${nav}
      <p class="muted"><a href="/filters">Muted words</a></p>
      <h1>${title}</h1>
      <form method="post" action="${mode.kind === "new" ? "/filters" : `/filters/${escapeHtml(mode.id)}/edit`}">
        <label for="title">Title</label>
        <input id="title" name="title" required maxlength="255" autocomplete="off" value="${escapeHtml(values.title)}" />
        <label for="expires_in">Expire after</label>
        <select id="expires_in" name="expires_in">${options([...keepExpiry, ...FILTER_EXPIRY_CHOICES], values.expires)}</select>
        <h2>Filter in</h2>${FILTER_CONTEXTS.map(([context, label]) =>
          checkbox(`context_${context}`, values.contexts.includes(context), label, ""),
        ).join("")}
        <label for="filter_action">Action</label>
        <select id="filter_action" name="filter_action">${options(
          [
            ["warn", ACTION_LABELS.warn],
            ["hide", ACTION_LABELS.hide],
          ],
          values.action,
        )}</select>
        <h2>Keywords</h2>${keywordRows(values.keywords)}${statusRows(mode, values.removeStatusIds)}
        <button type="submit">${mode.kind === "new" ? "Create filter" : "Save changes"}</button>
      </form>
${messageLine(message)}`,
  );
};

/** The answer for a filter id that is not the signed-in account's. */
export const filterNotFoundPage = (instanceName: string): string =>
  page(
    `Filter not found · ${instanceName}`,
    `${nav}
      <h1>Filter not found</h1>
      <p>There is no such filter, or it belongs to someone else.</p>
      <p><a href="/filters">Back to your filters</a></p>`,
  );
