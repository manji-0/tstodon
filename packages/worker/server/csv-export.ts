import { type ImportTypeValue, type InstanceIdentity } from "@tstodon/domain";
import { formatCsvRecord, guardCell } from "./csv";
import { type Entry, listEntriesPage } from "./csv-entries-store";

/** Entries read from D1 per page while an export streams. */
export const EXPORT_PAGE_SIZE = 200;

/**
 * The files Mastodon's export page offers, by the name in its URL
 * (`/settings/exports/follows.csv`).
 */
export const EXPORT_FILES: ReadonlyArray<
  Readonly<{ file: string; type: ImportTypeValue; label: string }>
> = [
  { file: "follows.csv", type: { kind: "Following" }, label: "Follows" },
  { file: "lists.csv", type: { kind: "Lists" }, label: "Lists" },
  { file: "blocks.csv", type: { kind: "Blocks" }, label: "Blocked users" },
  { file: "mutes.csv", type: { kind: "Mutes" }, label: "Muted users" },
  { file: "domain_blocks.csv", type: { kind: "DomainBlocks" }, label: "Blocked domains" },
  { file: "bookmarks.csv", type: { kind: "Bookmarks" }, label: "Bookmarks" },
];

/** The header Mastodon writes for a type, when it writes one. */
const header = (type: ImportTypeValue): ReadonlyArray<string> | undefined => {
  switch (type.kind) {
    case "Following":
      return ["Account address", "Show boosts", "Notify on new posts", "Languages"];
    case "Mutes":
      return ["Account address", "Hide notifications"];
    case "Lists":
    case "Blocks":
    case "DomainBlocks":
    case "Bookmarks":
      return undefined;
  }
};

const flag = (value: boolean): string => (value ? "true" : "false");

/** The CSV cells of an entry, in Mastodon's column order. */
export const exportCells = (entry: Entry): ReadonlyArray<string> => {
  switch (entry.kind) {
    case "Following":
      return [entry.acct, flag(entry.reblogs), flag(entry.notify), entry.languages.join(", ")];
    case "Blocks":
      return [entry.acct];
    case "Mutes":
      return [entry.acct, flag(entry.hideNotifications)];
    case "DomainBlocks":
      return [entry.domain];
    case "Lists":
      return [entry.title, entry.acct];
    case "Bookmarks":
      return [entry.uri];
  }
};

/**
 * The export file of `type` as UTF-8 chunks, one page of
 * {@link EXPORT_PAGE_SIZE} entries at a time, so no more than a page is in
 * memory however much the account holds. A read that fails ends the stream
 * with an error, which the client sees as a cut-off download.
 */
export const exportStream = (
  db: D1Database,
  identity: InstanceIdentity,
  accountId: string,
  type: ImportTypeValue,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let after = "";
  let done = false;
  let headerPending = true;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let text = "";
      const columns = header(type);
      if (headerPending && columns) {
        text += formatCsvRecord(columns);
      }
      headerPending = false;
      while (text === "" && !done) {
        const page = await listEntriesPage(db, identity, accountId, type, after, EXPORT_PAGE_SIZE);
        if (page.isErr()) {
          controller.error(new Error(page.error.message));
          return;
        }
        text += page.value.entries
          .map((entry) => formatCsvRecord(exportCells(entry).map(guardCell)))
          .join("");
        if (page.value.next === undefined) {
          done = true;
        } else {
          after = page.value.next;
        }
      }
      if (text !== "") {
        controller.enqueue(encoder.encode(text));
      }
      if (done) {
        controller.close();
      }
    },
  });
};
