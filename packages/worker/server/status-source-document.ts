import type {
  ApiOriginalStatusJSON,
  ApiQuoteJSON,
  ApiQuotedStatusJSON,
  ApiShallowQuoteJSON,
  ApiSourceOriginalStatusJSON,
  ApiSourceQuoteJSON,
  ApiSourceQuotedStatusJSON,
  ApiSourceShallowQuoteJSON,
  ApiSourceStatusJSON,
} from "@tstodon/api";
import {
  type InstanceIdentity,
  type LocalStatus,
  type QuoteValue,
  StatusTarget,
  type StatusTargetValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { mastodonStatus } from "./local-status-documents";
import { isQuotedStatusShown, type QuotedDocument } from "./quote-document";
import { findQuotesByQuoting } from "./quote-store";
import { quotedDocuments, quotedStatuses } from "./remote-status-documents";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { findStatusesByIds } from "./status-store";

const notAccepted = (quote: QuoteValue): boolean => quote.state.kind !== "Accepted";

const quotedTargets = (quotes: Iterable<QuoteValue>): StatusTargetValue[] =>
  [...quotes].flatMap(({ quoted }) => (quoted.kind === "Unresolved" ? [] : [quoted]));

/**
 * The source of each status in `targets` as Mastodon's `Status#text` holds
 * it: a local note's text as written, a boost's empty text, and a remote
 * status's HTML as received.
 */
const sourceTexts = async (
  db: D1Database,
  targets: ReadonlyArray<StatusTargetValue>,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const idsOf = (kind: StatusTargetValue["kind"]) =>
    targets.flatMap((target) => (target.kind === kind ? [target.statusId] : []));
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(db, idsOf("LocalStatus")),
    findRemoteStatusesByIds(db, idsOf("RemoteStatus")),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  return ok(
    new Map([
      ...[...locals.value.values()].map(
        (status) => [status.id, status.kind === "LocalNote" ? status.text : ""] as const,
      ),
      ...[...remotes.value.values()].map((status) => [status.id, status.contentHtml] as const),
    ]),
  );
};

/**
 * A local status rendered as `DELETE /api/v1/statuses/:id` answers it, as
 * Mastodon's `REST::StatusSerializer` with `source_requested: true`. Each
 * status in it, the boosted and the quoted one too, has its source as `text`
 * and no `content`, and a quote that is not accepted (pending, rejected,
 * revoked) still shows its status, where the viewer may see it, so a redraft
 * quotes it again (`BaseQuoteSerializer#quoted_status`).
 */
export const mastodonSourceStatus = async (
  env: Env,
  identity: InstanceIdentity,
  status: LocalStatus,
  viewerId: string,
): Promise<Result<ApiSourceStatusJSON | undefined, RepositoryError>> => {
  const rendered = await mastodonStatus(env, identity, status, viewerId);
  if (rendered.isErr() || rendered.value === undefined) {
    return rendered.map(() => undefined);
  }
  const document = rendered.value;
  // The statuses rendered with their quote in full: this one and what it boosts.
  const full = [
    StatusTarget.local(status.id),
    ...(status.kind === "LocalReblog" ? [status.target] : []),
  ];
  const fullQuotes = await findQuotesByQuoting(env.DB, full);
  if (fullQuotes.isErr()) {
    return err(fullQuotes.error);
  }
  // The statuses those quote, rendered with their own quote by id only.
  const shallow = quotedTargets(fullQuotes.value.values());
  const shallowQuotes = await findQuotesByQuoting(env.DB, shallow);
  if (shallowQuotes.isErr()) {
    return err(shallowQuotes.error);
  }
  const [unacceptedDocuments, unacceptedAccess, texts] = await Promise.all([
    quotedDocuments(env, identity, [...fullQuotes.value.values()].filter(notAccepted), viewerId),
    quotedStatuses(env.DB, [...shallowQuotes.value.values()].filter(notAccepted), viewerId),
    sourceTexts(env.DB, [...full, ...shallow]),
  ]);
  if (unacceptedDocuments.isErr()) {
    return err(unacceptedDocuments.error);
  }
  if (unacceptedAccess.isErr()) {
    return err(unacceptedAccess.error);
  }
  if (texts.isErr()) {
    return err(texts.error);
  }
  const textOf = (id: string, content: string): string => texts.value.get(id) ?? content;

  const shallowQuote = (
    statusId: string,
    quote: ApiShallowQuoteJSON,
  ): ApiSourceShallowQuoteJSON => {
    switch (quote.state) {
      case "pending":
      case "rejected":
      case "revoked": {
        const row = shallowQuotes.value.get(statusId);
        const quoted =
          row === undefined ||
          row.quoted.kind === "Unresolved" ||
          !isQuotedStatusShown(unacceptedAccess.value.access(row))
            ? null
            : row.quoted.statusId;
        return { state: quote.state, quoted_status_id: quoted };
      }
      default:
        return quote;
    }
  };
  const quotedStatus = ({
    content,
    quote,
    ...fields
  }: ApiQuotedStatusJSON): ApiSourceQuotedStatusJSON => ({
    ...fields,
    text: textOf(fields.id, content),
    ...(quote === undefined ? {} : { quote: quote && shallowQuote(fields.id, quote) }),
  });
  const fullQuote = (statusId: string, quote: ApiQuoteJSON): ApiSourceQuoteJSON => {
    switch (quote.state) {
      case "pending":
      case "rejected":
      case "revoked": {
        const row = fullQuotes.value.get(statusId);
        const shown: QuotedDocument = row && unacceptedDocuments.value(row);
        return {
          state: quote.state,
          quoted_status: typeof shown === "object" ? quotedStatus(shown.document) : null,
        };
      }
      case "deleted":
      case "unauthorized":
        return { state: quote.state, quoted_status: null };
      default:
        return { state: quote.state, quoted_status: quotedStatus(quote.quoted_status) };
    }
  };
  const original = ({
    content,
    quote,
    ...fields
  }: ApiOriginalStatusJSON): ApiSourceOriginalStatusJSON => ({
    ...fields,
    text: textOf(fields.id, content),
    ...(quote === undefined ? {} : { quote: quote && fullQuote(fields.id, quote) }),
  });

  const { content, quote, reblog, ...fields } = document;
  return ok({
    ...fields,
    text: textOf(fields.id, content),
    ...(reblog === undefined ? {} : { reblog: reblog && original(reblog) }),
    ...(quote === undefined ? {} : { quote: quote && fullQuote(fields.id, quote) }),
  });
};
