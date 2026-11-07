import { schemaResult, unitKind } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { IsoInstant } from "./iso-instant";
import { StatusTargetSchema } from "./status-target";

/**
 * Why an accepted quote may show its quoted status: the quoted status is
 * local (or the quote is a self-quote), or the remote quoted author sent a
 * `QuoteAuthorization` stamp.
 */
export const QuoteApprovalSchema = z.discriminatedUnion("kind", [
  unitKind("Implicit"),
  z.object({ kind: z.literal("Stamp"), uri: z.url() }),
]);

export type QuoteApproval = z.infer<typeof QuoteApprovalSchema>;

/** Mastodon's quote states. Only an accepted quote carries its approval. */
export const QuoteStateSchema = z.discriminatedUnion("kind", [
  unitKind("Pending"),
  z.object({ kind: z.literal("Accepted"), approval: QuoteApprovalSchema }),
  unitKind("Rejected"),
  unitKind("Revoked"),
  unitKind("Deleted"),
]);

export type QuoteState = z.infer<typeof QuoteStateSchema>;

/**
 * What a quote quotes: a local or cached remote status, or the URI of a
 * remote note that could not be fetched yet (Mastodon's quote with no
 * `quoted_status`). Only a remote quoting status names an unresolved one.
 */
export const QuotedTargetSchema = z.discriminatedUnion("kind", [
  StatusTargetSchema,
  z.object({ kind: z.literal("Unresolved"), uri: z.url() }),
]);

export type QuotedTarget = z.infer<typeof QuotedTargetSchema>;

export const QuotedTarget = {
  schema: QuotedTargetSchema,
  parse: schemaResult(QuotedTargetSchema),
  unresolved: (uri: string): QuotedTarget => ({ kind: "Unresolved", uri }),
  /** Whether both name the same status, or the same unresolved URI. */
  equals: (a: QuotedTarget, b: QuotedTarget): boolean => {
    if (a.kind === "Unresolved") {
      return b.kind === "Unresolved" && a.uri === b.uri;
    }
    return b.kind === a.kind && b.statusId === a.statusId;
  },
} as const;

/** One status quoting another; either end is local or cached remote. */
export const QuoteSchema = z.object({
  id: z.string().min(1),
  quoting: StatusTargetSchema,
  quoted: QuotedTargetSchema,
  state: QuoteStateSchema,
  /**
   * The quoting note named its quoted status only by a pre-FEP-044f property
   * (`_misskey_quote`, `quoteUrl`, `quoteUri`), as Mastodon's `Quote#legacy`;
   * such a quote is not shown until it is accepted.
   */
  legacy: z.boolean(),
  /** The `QuoteRequest` id, when the quote went over the wire. */
  activityUri: z.url().optional(),
  createdAt: IsoInstant.schema,
});

export type Quote = z.infer<typeof QuoteSchema>;

export type QuoteTransitionError = Readonly<{ kind: "NotPending" } | { kind: "NotAccepted" }>;

export const Quote = {
  schema: QuoteSchema,
  parse: schemaResult(QuoteSchema),
  /** Whether the quoting status renders this quote, as Mastodon's `Quote#acceptable?`. */
  isShown: (quote: Quote): boolean => quote.state.kind === "Accepted" || !quote.legacy,
  /** The quoted author approved; as Mastodon's `accept_quote!`, only a pending quote. */
  accept: (quote: Quote, approval: QuoteApproval): Result<Quote, QuoteTransitionError> =>
    quote.state.kind === "Pending"
      ? ok({ ...quote, state: { kind: "Accepted", approval } })
      : err({ kind: "NotPending" }),
  /**
   * The quoted author said no, as Mastodon's `Quote#reject!`: an accepted
   * quote becomes revoked, a revoked one stays, anything else is rejected.
   */
  reject: (quote: Quote): Quote => {
    switch (quote.state.kind) {
      case "Accepted":
        return { ...quote, state: { kind: "Revoked" } };
      case "Revoked":
        return quote;
      default:
        return { ...quote, state: { kind: "Rejected" } };
    }
  },
  /** The quoted author withdraws an accepted quote. */
  revoke: (quote: Quote): Result<Quote, QuoteTransitionError> =>
    quote.state.kind === "Accepted"
      ? ok({ ...quote, state: { kind: "Revoked" } })
      : err({ kind: "NotAccepted" }),
} as const;
