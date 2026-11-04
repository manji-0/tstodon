import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

/**
 * Mastodon's data import (`/settings/import`): a CSV file of one type, applied
 * to the account in one mode, row by row. The types and the CSV layouts are
 * Mastodon's own, so a file exported there imports here and the other way.
 */

const ImportTypeSchema = z.discriminatedUnion("kind", [
  unitKind("Following"),
  unitKind("Lists"),
  unitKind("Blocks"),
  unitKind("Mutes"),
  unitKind("DomainBlocks"),
  unitKind("Bookmarks"),
]);

export type ImportType = z.infer<typeof ImportTypeSchema>;

export const ImportType = {
  schema: ImportTypeSchema,
  parse: schemaResult(ImportTypeSchema),
  /** Every type, in the order the pages list them. */
  all: [
    { kind: "Following" },
    { kind: "Lists" },
    { kind: "Blocks" },
    { kind: "Mutes" },
    { kind: "DomainBlocks" },
    { kind: "Bookmarks" },
  ] as const satisfies ReadonlyArray<ImportType>,
} as const;

/**
 * `Merge` adds the file's entries to what the account has. `Overwrite` also
 * removes the entries of that type that the file does not name (for lists,
 * only in the lists the file names).
 */
const ImportModeSchema = z.discriminatedUnion("kind", [unitKind("Merge"), unitKind("Overwrite")]);

export type ImportMode = z.infer<typeof ImportModeSchema>;

export const ImportMode = {
  schema: ImportModeSchema,
  parse: schemaResult(ImportModeSchema),
} as const;

/** A row that passed the file checks: what to apply, by type. */
const ImportRowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("Following"),
    handle: z.string().min(1),
    reblogs: z.boolean(),
    notify: z.boolean(),
    languages: z.array(z.string()),
  }),
  z.object({ kind: z.literal("Lists"), listTitle: z.string().min(1), handle: z.string().min(1) }),
  z.object({ kind: z.literal("Blocks"), handle: z.string().min(1) }),
  z.object({ kind: z.literal("Mutes"), handle: z.string().min(1), hideNotifications: z.boolean() }),
  z.object({ kind: z.literal("DomainBlocks"), domain: z.string().min(1) }),
  z.object({ kind: z.literal("Bookmarks"), statusId: z.string().min(1) }),
]);

export type ImportRow = z.infer<typeof ImportRowSchema>;

export const ImportRow = {
  schema: ImportRowSchema,
  parse: schemaResult(ImportRowSchema),
} as const;

/** Why a row was not applied. */
const RowFailureSchema = z.discriminatedUnion("kind", [
  /** The line is not a valid row of the file's type. */
  unitKind("Malformed"),
  /** No account answers to the handle (or its server did not answer). */
  unitKind("UnknownAccount"),
  /** A block, a domain block, or federation limits forbid it, or it is the account itself. */
  unitKind("Refused"),
  /** A list takes only accounts the owner follows. */
  unitKind("NotFollowed"),
  /** The post is not on this server, or the account cannot see it. */
  unitKind("Unsupported"),
]);

export type RowFailure = z.infer<typeof RowFailureSchema>;

export const RowFailure = {
  schema: RowFailureSchema,
  parse: schemaResult(RowFailureSchema),
} as const;

const RowOutcomeSchema = z.discriminatedUnion("kind", [
  unitKind("Pending"),
  unitKind("Applied"),
  z.object({ kind: z.literal("Failed"), failure: RowFailureSchema }),
]);

export type RowOutcome = z.infer<typeof RowOutcomeSchema>;

export const RowOutcome = {
  schema: RowOutcomeSchema,
  parse: schemaResult(RowOutcomeSchema),
} as const;
