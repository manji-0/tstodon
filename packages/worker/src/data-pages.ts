import { ImportType, type ImportTypeValue, type RowFailureValue } from "@tstodon/domain";
import { page } from "./auth-pages";
import { EXPORT_FILES } from "./csv-export";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "./csv-import-file";
import type { CsvImport, FailedRow } from "./csv-import-store";
import { escapeHtml } from "./html";
import { messageLine, nav, options, type PageMessage } from "./settings-pages";

/**
 * Mastodon's "Import and export" settings: `/settings/export` to download
 * the account's data as CSV, `/settings/import` to upload it, and the
 * per-file progress with the rows that failed.
 */

/** How many failed rows an import's page lists. */
export const FAILED_ROWS_SHOWN = 100;

const TYPE_LABELS: Readonly<Record<ImportTypeValue["kind"], string>> = {
  Following: "Follows",
  Lists: "Lists",
  Blocks: "Blocked users",
  Mutes: "Muted users",
  DomainBlocks: "Blocked domains",
  Bookmarks: "Bookmarks",
};

export const importTypeLabel = (type: ImportTypeValue): string => TYPE_LABELS[type.kind];

const FAILURE_TEXT: Readonly<Record<RowFailureValue["kind"], string>> = {
  Malformed: "This row is not a valid row for this type of file.",
  UnknownAccount: "No account was found for this handle, or its server did not answer.",
  Refused: "Not allowed: a block, a blocked domain, federation limits, or your own account.",
  NotFollowed: "You must follow this account before you can add it to a list.",
  Unsupported: "This post is not on this server, or you cannot see it.",
};

export const failureText = (failure: RowFailureValue): string => FAILURE_TEXT[failure.kind];

export const exportPage = (instanceName: string): string =>
  page(
    `Export · ${instanceName}`,
    `${nav}
      <h1>Export</h1>
      <p>Download your data as CSV files. Mastodon and other servers that follow its format can import them, and so can <a href="/settings/import">this server</a>.</p>
      <ul>${EXPORT_FILES.map(
        (file) => `
        <li><a href="/settings/exports/${escapeHtml(file.file)}" download>${escapeHtml(file.label)}</a></li>`,
      ).join("")}
      </ul>
      <p class="muted">Follows list the accounts you follow with their boost, notification, and language options. Lists name the list and each account on it. Bookmarks list the posts of this server that you bookmarked.</p>
      <p><a href="/settings/import">Import</a></p>`,
  );

const progress = (imported: CsvImport): string => {
  const { pending, applied, failed } = imported.counts;
  return `${applied} done, ${failed} failed${pending > 0 ? `, ${pending} waiting` : ""}`;
};

const stateText = (imported: CsvImport): string =>
  imported.state === "Queued" ? "Running" : "Finished";

const REFRESH_SCRIPT = `      setTimeout(() => location.reload(), 5000);`;

export const importPage = (
  instanceName: string,
  imports: ReadonlyArray<CsvImport>,
  message?: PageMessage,
): string =>
  page(
    `Import · ${instanceName}`,
    `${nav}
      <h1>Import</h1>
      <p>Upload a CSV file exported from Mastodon or from <a href="/settings/export">this server</a>. The file is applied a few rows at a time in the background, and this page shows how far it is. A file may be up to ${MAX_IMPORT_BYTES / 1_048_576} MB and ${MAX_IMPORT_ROWS} rows.</p>
      <form method="post" action="/settings/import" enctype="multipart/form-data">
        <label for="type">Data type</label>
        <select id="type" name="type">${options(
          ImportType.all.map((type) => [type.kind, importTypeLabel(type)]),
          "Following",
        )}</select>
        <label for="mode">Import mode</label>
        <select id="mode" name="mode">${options(
          [
            ["Merge", "Merge: add to what you have"],
            ["Overwrite", "Overwrite: also remove what the file does not list"],
          ],
          "Merge",
        )}</select>
        <label for="data">CSV file</label>
        <input id="data" name="data" type="file" accept=".csv,text/csv" required />
        <button type="submit">Upload</button>
      </form>
${messageLine(message)}
      <p class="muted">Lists are added to the lists with the same title (new ones are created); an account joins a list only while you follow it, so import follows first. Bookmarks need posts of this server. An overwrite is refused when a line of the file cannot be read.</p>
      <h2>Recent imports</h2>${
        imports.length === 0
          ? `
      <p class="muted">No imports yet.</p>`
          : `
      <ul>${imports
        .map(
          (imported) => `
        <li><a href="/settings/imports/${escapeHtml(imported.id)}">${escapeHtml(importTypeLabel(imported.type))} (${escapeHtml(imported.mode.kind.toLowerCase())})</a>: ${escapeHtml(stateText(imported))}, ${escapeHtml(progress(imported))}</li>`,
        )
        .join("")}
      </ul>`
      }`,
    imports.some((imported) => imported.state === "Queued") ? REFRESH_SCRIPT : "",
  );

export const importDetailPage = (
  instanceName: string,
  imported: CsvImport,
  failures: ReadonlyArray<FailedRow>,
): string =>
  page(
    `${importTypeLabel(imported.type)} import · ${instanceName}`,
    `${nav}
      <p class="muted"><a href="/settings/import">Back to imports</a></p>
      <h1>${escapeHtml(importTypeLabel(imported.type))} import</h1>
      <p>${escapeHtml(stateText(imported))} (${escapeHtml(imported.mode.kind.toLowerCase())}): ${escapeHtml(progress(imported))}.</p>${
        imported.state === "Finished" && imported.mode.kind === "Overwrite"
          ? `
      <p class="muted">Entries the file does not list were removed.</p>`
          : ""
      }
      <h2>Rows that failed</h2>${
        failures.length === 0
          ? `
      <p class="muted">None.</p>`
          : `
      <ul>${failures
        .map(
          (failure) => `
        <li>Row ${failure.position}: <code>${escapeHtml(failure.input)}</code> <span class="muted">${escapeHtml(failureText(failure.failure))}</span></li>`,
        )
        .join("")}
      </ul>${
        imported.counts.failed > failures.length
          ? `
      <p class="muted">${imported.counts.failed - failures.length} more not shown.</p>`
          : ""
      }`
      }`,
    imported.state === "Queued" ? REFRESH_SCRIPT : "",
  );
