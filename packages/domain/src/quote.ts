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

/** One status quoting another; either end is local or cached remote. */
export const QuoteSchema = z.object({
  id: z.string().min(1),
  quoting: StatusTargetSchema,
  quoted: StatusTargetSchema,
  state: QuoteStateSchema,
  /** The `QuoteRequest` id, when the quote went over the wire. */
  activityUri: z.url().optional(),
  createdAt: IsoInstant.schema,
});

export type Quote = z.infer<typeof QuoteSchema>;

export type QuoteTransitionError = Readonly<{ kind: "NotPending" } | { kind: "NotAccepted" }>;

export const Quote = {
  schema: QuoteSchema,
  parse: schemaResult(QuoteSchema),
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
