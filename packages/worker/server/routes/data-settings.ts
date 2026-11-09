import { ImportMode, ImportType } from "@tstodon/domain";
import { errorPage } from "../auth-pages";
import { startCsvImport } from "../csv-import-apply";
import { EXPORT_FILES, exportStream } from "../csv-export";
import {
  type ImportFileError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  parseImportFile,
} from "../csv-import-file";
import {
  createCsvImport,
  deleteCsvImport,
  findCsvImport,
  listCsvImports,
  listFailedRows,
} from "../csv-import-store";
import { exportPage, FAILED_ROWS_SHOWN, importDetailPage, importPage } from "../data-pages";
import { accountMediaBytes } from "../media-sizes";
import { pageRedirect } from "../page-redirect";
import { parseInstanceIdentity } from "../runtime-config";
import type { PageMessage } from "../settings-pages";
import { instanceName, type SettingsContext, settingsAccount } from "./account-settings";

/**
 * Mastodon's "Import and export" settings. Writes are form posts with the
 * same-origin check of `settingsAccount`; every read and write is scoped to
 * the signed-in account.
 */

/** `GET /settings/export`: the downloads, and the media storage the account uses. */
export const getSettingsExport = async (c: SettingsContext) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const media = await accountMediaBytes(c.env.DB, signedIn.account.id);
  return media.isErr()
    ? c.html(errorPage(instanceName(c.env), "The server could not read your media storage."), 500)
    : c.html(exportPage(instanceName(c.env), media.value));
};

/** `GET /settings/exports/:file`: one CSV file, read from D1 a page at a time. */
export const getSettingsExportFile = async (c: SettingsContext) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const identity = parseInstanceIdentity(c.env);
  const file = EXPORT_FILES.find((candidate) => candidate.file === c.req.param("file"));
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  if (!file) {
    return c.html(errorPage(instanceName(c.env), "There is no such file to download."), 404);
  }
  return new Response(exportStream(c.env.DB, identity.value, signedIn.account.id, file.type), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.file}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

/** The page's message for a `?error=` or `?notice=` code a refused upload redirects with. */
const importMessage = (c: SettingsContext): PageMessage | undefined => {
  const error = c.req.query("error");
  const count = Number(c.req.query("rows"));
  const first = Number(c.req.query("first"));
  if (error === "overwrite" && Number.isInteger(count) && Number.isInteger(first)) {
    return { kind: "error", text: overwriteRefusedText(count, first) };
  }
  const text = error === undefined ? undefined : IMPORT_ERRORS[error];
  return text === undefined ? undefined : { kind: "error", text };
};

/**
 * `GET /settings/import`: the upload form and the account's recent imports.
 * Only this page refreshes itself; a refused upload redirects here (see
 * {@link refusal}) so that no POST response is ever reloaded by the browser.
 */
export const getSettingsImport = async (c: SettingsContext) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const imports = await listCsvImports(c.env.DB, signedIn.account.id);
  return imports.isErr()
    ? c.html(errorPage(instanceName(c.env), "The server could not read your imports."), 500)
    : c.html(importPage(instanceName(c.env), imports.value, importMessage(c)));
};

/** `GET /settings/imports/:id`: one import's progress and failed rows. */
export const getSettingsImportById = async (c: SettingsContext) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const imported = await findCsvImport(c.env.DB, signedIn.account.id, c.req.param("id") ?? "");
  if (imported.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not read the import."), 500);
  }
  if (!imported.value) {
    return c.html(errorPage(instanceName(c.env), "There is no such import."), 404);
  }
  const failures = await listFailedRows(c.env.DB, imported.value.id, FAILED_ROWS_SHOWN);
  return failures.isErr()
    ? c.html(errorPage(instanceName(c.env), "The server could not read the import."), 500)
    : c.html(importDetailPage(instanceName(c.env), imported.value, failures.value));
};

/** The multipart envelope around a file at the size limit: boundaries and the other two fields. */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

const fileErrorText = (error: ImportFileError): string => {
  switch (error.kind) {
    case "TooLarge":
      return `The file is over ${MAX_IMPORT_BYTES / 1_048_576} MB.`;
    case "NotText":
      return "The file is not UTF-8 text. Upload a CSV file.";
    case "Unreadable":
      return "The file is not a CSV file this server can read (an unclosed quote, or too many columns).";
    case "TooManyRows":
      return `The file has more than ${MAX_IMPORT_ROWS} rows. Split it and upload the parts.`;
    case "NoRows":
      return "The file has no rows.";
  }
};

const IMPORT_ERRORS: Readonly<Record<string, string>> = {
  too_large: `The file is over ${MAX_IMPORT_BYTES / 1_048_576} MB.`,
  not_multipart: "Choose a CSV file to upload.",
  missing_fields: "Choose a data type, an import mode, and a CSV file.",
  running: "An import is still running. Wait for it to finish.",
  not_started: "The server could not start the import. Try again.",
  not_text: fileErrorText({ kind: "NotText" }),
  unreadable: fileErrorText({ kind: "Unreadable" }),
  too_many_rows: fileErrorText({ kind: "TooManyRows" }),
  no_rows: fileErrorText({ kind: "NoRows" }),
};

const FILE_ERROR_CODES: Readonly<Record<ImportFileError["kind"], string>> = {
  TooLarge: "too_large",
  NotText: "not_text",
  Unreadable: "unreadable",
  TooManyRows: "too_many_rows",
  NoRows: "no_rows",
};

const overwriteRefusedText = (count: number, first: number): string =>
  `${count} rows cannot be read, so nothing was imported: an overwrite would remove entries that belong to them. Fix the file, or use merge. The first is row ${first}.`;

/** Answer a refused upload with a redirect back to the page, never a page that a reload would re-POST. */
const refusal = (c: SettingsContext, query: string) =>
  pageRedirect(c, `/settings/import?error=${query}`, 303);

/** `POST /settings/import`, as a multipart form: `type`, `mode`, and the file `data`. */
export const postSettingsImport = async (c: SettingsContext) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const accountId = signedIn.account.id;
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  // The size is checked before the body is read, so an oversized upload is never buffered.
  const declared = c.req.header("Content-Length");
  const length = declared === undefined ? Number.NaN : Number(declared);
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > MAX_IMPORT_BYTES + MULTIPART_OVERHEAD_BYTES
  ) {
    return refusal(c, "too_large");
  }
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    return refusal(c, "not_multipart");
  }
  const form = await c.req.formData().then(
    (data) => data,
    () => undefined,
  );
  const type = ImportType.parse({ kind: form?.get("type") });
  const mode = ImportMode.parse({ kind: form?.get("mode") });
  const data = form?.get("data");
  if (type.isErr() || mode.isErr() || !(data instanceof File)) {
    return refusal(c, "missing_fields");
  }
  if (data.size > MAX_IMPORT_BYTES) {
    return refusal(c, "too_large");
  }
  const lines = parseImportFile(type.value, new Uint8Array(await data.arrayBuffer()), {
    localDomain: identity.value.domain,
    publicOrigin: identity.value.publicOrigin,
  });
  if (lines.isErr()) {
    return refusal(c, FILE_ERROR_CODES[lines.error.kind]);
  }
  const malformed = lines.value.filter(
    (line) => line.kind === "Rejected" && line.failure.kind === "Malformed",
  );
  if (mode.value.kind === "Overwrite" && malformed.length > 0) {
    return refusal(c, `overwrite&rows=${malformed.length}&first=${malformed[0]?.position ?? 0}`);
  }
  const created = await createCsvImport(c.env.DB, {
    accountId,
    type: type.value,
    mode: mode.value,
    lines: lines.value,
  });
  if (created.isErr()) {
    return c.html(
      errorPage(instanceName(c.env), "The server could not store the import. Try again."),
      500,
    );
  }
  if (created.value === undefined) {
    return refusal(c, "running");
  }
  if (created.value.state === "Queued" && !(await startCsvImport(c.env, created.value.id))) {
    await deleteCsvImport(c.env.DB, created.value.id);
    return refusal(c, "not_started");
  }
  return pageRedirect(c, `/settings/imports/${created.value.id}`, 303);
};
