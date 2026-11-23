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
  InstanceIdentity,
  type LocalAccount,
  type LocalStatus,
  type QuoteValue,
  StatusTarget,
  type StatusTargetValue,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { mastodonAccountDocument } from "./account-documents";
import { StatusAuthors } from "./account-presentation";
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
 * quotes it again (`BaseQuoteSerializer#quoted_status`). A boost has no
 * quote of its own. `author` is the status's author: whatever presentation
 * the boosted status's author has, the delete is answered, as Mastodon
 * always answers it; a boost whose boosted status is not cached is answered
 * with the boost alone ({@link unrenderedSource}).
 */
export const mastodonSourceStatus = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  status: LocalStatus,
): Promise<Result<ApiSourceStatusJSON, RepositoryError>> => {
  const rendered = await mastodonStatus(env, identity, status, author.id, StatusAuthors.any);
  if (rendered.isErr()) {
    return err(rendered.error);
  }
  if (rendered.value === undefined) {
    return ok(await unrenderedSource(env, identity, author, status));
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
    quotedDocuments(env, identity, [...fullQuotes.value.values()].filter(notAccepted), author.id),
    quotedStatuses(env.DB, [...shallowQuotes.value.values()].filter(notAccepted), author.id),
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
    // A boost's document carries what it boosts, but its own quote is none.
    ...(status.kind === "LocalReblog"
      ? { quote: null }
      : quote === undefined
        ? {}
        : { quote: quote && fullQuote(fields.id, quote) }),
  });
};

/**
 * The status alone, where the renderer gives nothing: a boost of a remote
 * status no longer cached. Its source, its author and its own settings,
 * nothing it points at.
 */
const unrenderedSource = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  status: LocalStatus,
): Promise<ApiSourceStatusJSON> => {
  const uri = `${InstanceIdentity.actorUrl(identity, author.username)}/statuses/${status.id}`;
  const note = status.kind === "LocalNote" ? status : undefined;
  return {
    id: status.id,
    created_at: status.createdAt,
    in_reply_to_id: note?.inReplyToId ?? null,
    in_reply_to_account_id: null,
    sensitive: note?.sensitive ?? false,
    spoiler_text: note?.spoilerText ?? "",
    visibility: Visibility.toMastodon(status.visibility),
    language: note?.language.kind === "Present" ? note.language.value : null,
    uri: note ? uri : `${uri}/activity`,
    url: note ? InstanceIdentity.statusUrl(identity, author.username, status.id) : null,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    quotes_count: 0,
    edited_at: note?.editedAt ?? null,
    text: note?.text ?? "",
    reblog: null,
    account: await mastodonAccountDocument(env, identity, author),
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
    quote: null,
    quote_approval: { automatic: [], manual: [], current_user: "denied" },
    tagged_collections: [],
  };
};
