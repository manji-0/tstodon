import type {
  ApiOriginalStatusJSON,
  ApiQuoteJSON,
  ApiQuotedStatusJSON,
  ApiShallowQuoteJSON,
} from "@tstodon/api";
import {
  type InstanceIdentity,
  type LocalStatus,
  Quote,
  type QuoteValue,
  type QuoteViewerRelation,
  QuoteInteractionPolicy,
  type RemoteStatusValue,
  StatusTarget,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { presentedAccounts } from "./account-documents";
import { StatusAuthors } from "./account-presentation";
import { parseLocalStatusId } from "./activitypub";
import type { RepositoryError } from "./d1";
import { cardDocument, parseCardJson } from "./link-card";
import { RemoteAccountId } from "./remote-account-id";
import { mastodonShallowStatuses } from "./local-status-documents";
import {
  isQuotedStatusShown,
  mastodonQuote,
  mastodonShallowQuote,
  type QuotedDocument,
  type QuotedStatusAccess,
} from "./quote-document";
import { findQuotesByQuoting, quoteCountsByQuoted } from "./quote-store";
import { listRemoteActorModerations } from "./remote-actor-moderation-store";
import { findRemoteActorsByUris, remoteFollowerActorUris } from "./remote-actor-store";
import { acceptedOutboundFollowActorUris } from "./outbound-follow-store";
import { findRemotePollVotes } from "./remote-poll-vote-store";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";
import { mastodonRemoteStatus } from "./remote-status-document";
import { documentsById } from "./documents-by-id";
import { findRemoteStatusesByIds, findRemoteStatusRefsByObjectUris } from "./remote-status-store";
import { listRemoteStatusCards } from "./status-card-store";
import { statusInteractionCountsByIds } from "./status-interaction-store";
import { findStatusesByIds } from "./status-store";
import { quotedStatusAccess } from "./quoted-status-access";

/** The reply fields of a rendered status, which {@link attachRemoteReplyRefs} fills in. */
type ReplyRefs = {
  readonly id: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
};

/**
 * Fill `in_reply_to_id` and `in_reply_to_account_id` on remote status
 * documents from the `inReplyTo` stored with them: a local parent by its id
 * and author, a cached remote one by its id and `r_…` author. A parent that
 * is not stored here stays null, as Mastodon renders an unfetched parent.
 * Other documents in the list are left alone.
 */
export const attachRemoteReplyRefs = async (
  db: D1Database,
  identity: InstanceIdentity,
  documents: ReadonlyArray<ReplyRefs>,
): Promise<void> => {
  const ids = documents.flatMap((document) =>
    document.in_reply_to_id === null ? [document.id] : [],
  );
  const targets = await findRemoteStatusReplyTargets(db, ids);
  if (targets.isErr() || targets.value.size === 0) {
    return;
  }
  const localParents = new Map<string, string>();
  const remoteParents: string[] = [];
  for (const target of targets.value.values()) {
    const uri = target.inReplyToUri;
    if (!uri) {
      continue;
    }
    const localId = parseLocalStatusId(identity, uri);
    if (localId) {
      localParents.set(uri, localId);
    } else {
      remoteParents.push(uri);
    }
  }
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(db, [...localParents.values()]),
    findRemoteStatusRefsByObjectUris(db, remoteParents),
  ]);
  for (const document of documents) {
    const target = targets.value.get(document.id);
    const uri = target?.inReplyToUri;
    if (!uri) {
      continue;
    }
    const localId = localParents.get(uri);
    if (localId) {
      const parent = locals.isOk() ? locals.value.get(localId) : undefined;
      if (parent) {
        document.in_reply_to_id = parent.id;
        document.in_reply_to_account_id = parent.accountId;
      }
      continue;
    }
    const parent = remotes.isOk() ? remotes.value.get(uri) : undefined;
    if (parent) {
      document.in_reply_to_id = parent.id;
      document.in_reply_to_account_id = RemoteAccountId.encode(parent.actorUri);
    }
  }
};

/**
 * How the viewer and each remote author follow each other, keyed by actor
 * URI; empty for no viewer. A local viewer is never a remote author. A
 * failed read counts as no follow, so it only withholds quoting.
 */
export const quoteViewerRelations = async (
  db: D1Database,
  viewerId: string | undefined,
  actorUris: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, QuoteViewerRelation>> => {
  if (viewerId === undefined) {
    return new Map();
  }
  const [following, followers] = await Promise.all([
    acceptedOutboundFollowActorUris(db, viewerId, actorUris),
    remoteFollowerActorUris(db, viewerId, actorUris),
  ]);
  return new Map(
    actorUris.map((actorUri) => [
      actorUri,
      {
        viewerIsAuthor: false,
        viewerFollowsAuthor: following.isOk() && following.value.has(actorUri),
        authorFollowsViewer: followers.isOk() && followers.value.has(actorUri),
      },
    ]),
  );
};

/**
 * The statuses accepted `quotes` quote, as stored, with what the viewer is
 * shown of each, as Mastodon's `StatusFilter#filter_state_for_quote`.
 */
const quotedStatuses = async (
  db: D1Database,
  quotes: ReadonlyArray<QuoteValue>,
  viewerId: string | undefined,
): Promise<
  Result<
    Readonly<{
      locals: LocalStatus[];
      remotes: RemoteStatusValue[];
      access: (quote: QuoteValue) => QuotedStatusAccess;
    }>,
    RepositoryError
  >
> => {
  const accepted = quotes.filter((quote) => quote.state.kind === "Accepted");
  const idsOf = (kind: "LocalStatus" | "RemoteStatus") =>
    accepted.flatMap(({ quoted }) => (quoted.kind === kind ? [quoted.statusId] : []));
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
  const accessOf = await quotedStatusAccess(
    db,
    [...locals.value.values()],
    [...remotes.value.values()],
    viewerId,
  );
  if (accessOf.isErr()) {
    return err(accessOf.error);
  }
  const access = ({ quoted }: QuoteValue): QuotedStatusAccess =>
    quoted.kind === "Unresolved" ? "Gone" : accessOf.value(quoted);
  return ok({
    locals: [...locals.value.values()].filter((status) =>
      isQuotedStatusShown(accessOf.value(StatusTarget.local(status.id))),
    ),
    remotes: [...remotes.value.values()].filter((status) =>
      isQuotedStatusShown(accessOf.value(StatusTarget.remote(status.id))),
    ),
    access,
  });
};

/**
 * The statuses `quotes` quote, rendered for the viewer: the ones the viewer
 * may see, a quoted remote one showing its own quote shallow, which ends the
 * recursion.
 */
const quotedDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  quotes: ReadonlyArray<QuoteValue>,
  viewerId: string | undefined,
): Promise<Result<(quote: QuoteValue) => QuotedDocument, RepositoryError>> => {
  const quoted = await quotedStatuses(env.DB, quotes, viewerId);
  if (quoted.isErr()) {
    return err(quoted.error);
  }
  const { locals, remotes, access } = quoted.value;
  const [localDocuments, remoteDocuments] = await Promise.all([
    mastodonShallowStatuses(env, identity, locals, viewerId),
    mastodonShallowRemoteStatuses(env, identity, remotes, viewerId),
  ]);
  if (localDocuments.isErr()) {
    return err(localDocuments.error);
  }
  if (remoteDocuments.isErr()) {
    return err(remoteDocuments.error);
  }
  const rendered = documentsById([...localDocuments.value, ...remoteDocuments.value]);
  return ok((quote) => {
    const shown = access(quote);
    if (shown === "Gone" || quote.quoted.kind === "Unresolved") {
      return undefined;
    }
    if (!isQuotedStatusShown(shown)) {
      return "Unauthorized";
    }
    const document = rendered.get(quote.quoted.statusId);
    return document ? { access: shown, document } : "Unauthorized";
  });
};

/**
 * How each of `quotes` renders as its quoting status's `quote`: in full, as
 * Mastodon's `QuoteSerializer`.
 */
const fullQuoteRenderer = async (
  env: Env,
  identity: InstanceIdentity,
  quotes: ReadonlyArray<QuoteValue>,
  viewerId: string | undefined,
): Promise<Result<(quote: QuoteValue) => ApiQuoteJSON, RepositoryError>> =>
  (await quotedDocuments(env, identity, quotes, viewerId)).map(
    (documentOf) => (quote) => mastodonQuote(quote.state, () => documentOf(quote)),
  );

/**
 * How each of `quotes` renders as the `quote` of a status shown inside a
 * quote: by id only, as Mastodon's `ShallowQuoteSerializer`, which ends the
 * nesting.
 */
const shallowQuoteRenderer = async (
  env: Env,
  _identity: InstanceIdentity,
  quotes: ReadonlyArray<QuoteValue>,
  viewerId: string | undefined,
): Promise<Result<(quote: QuoteValue) => ApiShallowQuoteJSON, RepositoryError>> =>
  (await quotedStatuses(env.DB, quotes, viewerId)).map(
    ({ access }) =>
      (quote) =>
        mastodonShallowQuote(
          quote.state,
          quote.quoted.kind === "Unresolved" ? null : quote.quoted.statusId,
          () => access(quote),
        ),
  );

/**
 * Cached remote statuses rendered for the viewer, each showing its quote as
 * `renderer` renders it. See {@link mastodonRemoteStatuses}.
 */
const renderRemoteStatuses = async <Q>(
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<RemoteStatusValue>,
  viewerId: string | undefined,
  authors: StatusAuthors,
  renderer: (
    env: Env,
    identity: InstanceIdentity,
    quotes: ReadonlyArray<QuoteValue>,
    viewerId: string | undefined,
  ) => Promise<Result<(quote: QuoteValue) => Q, RepositoryError>>,
): Promise<
  Result<(Omit<ApiOriginalStatusJSON, "quote"> & { quote: Q | null })[], RepositoryError>
> => {
  if (statuses.length === 0) {
    return ok([]);
  }
  const ids = statuses.map((status) => status.id);
  const actorUris = statuses.map((status) => status.actorUri);
  const targets = statuses.map((status) => StatusTarget.remote(status.id));
  const [cards, actors, moderations, pollVotes, interactions, relations, quoteCounts, quotes] =
    await Promise.all([
      listRemoteStatusCards(env.DB, ids),
      findRemoteActorsByUris(env.DB, actorUris),
      listRemoteActorModerations(env.DB, actorUris),
      findRemotePollVotes(env.DB, viewerId, statuses),
      statusInteractionCountsByIds(env.DB, ids, viewerId),
      quoteViewerRelations(env.DB, viewerId, actorUris),
      quoteCountsByQuoted(env.DB, targets),
      findQuotesByQuoting(env.DB, targets),
    ]);
  if (actors.isErr()) {
    return err(actors.error);
  }
  if (quotes.isErr()) {
    return err(quotes.error);
  }
  const renderQuote = await renderer(env, identity, [...quotes.value.values()], viewerId);
  if (renderQuote.isErr()) {
    return err(renderQuote.error);
  }
  const presented = await presentedAccounts(env, identity, [], [...actors.value.values()]);
  if (presented.isErr()) {
    return err(presented.error);
  }
  const documents = statuses.flatMap((status) => {
    const author = presented.value.get(RemoteAccountId.encode(status.actorUri));
    if (!author || !authors(author.presentation)) {
      return [];
    }
    const rawCard = cards.isOk() ? cards.value.get(status.id) : undefined;
    const card = rawCard ? parseCardJson(rawCard) : undefined;
    const document = mastodonRemoteStatus(status, author.document, {
      card: card ? cardDocument(card) : null,
      pollVotes: pollVotes.get(status.id),
      interactions: interactions.isOk() ? interactions.value.get(status.id) : undefined,
      quotesCount: quoteCounts.isOk() ? quoteCounts.value.get(status.id) : undefined,
      quoteApproval: QuoteInteractionPolicy.forViewer(
        status.quotePolicy,
        status.visibility,
        relations.get(status.actorUri),
      ),
    });
    const quote = quotes.value.get(status.id);
    const sensitized = moderations.isOk() && moderations.value.get(status.actorUri)?.sensitized;
    return [
      {
        ...document,
        quote: quote && Quote.isShown(quote) ? renderQuote.value(quote) : null,
        sensitive: document.sensitive || (sensitized === true && status.media.length > 0),
      },
    ];
  });
  await attachRemoteReplyRefs(env.DB, identity, documents);
  return ok(documents);
};

/**
 * Cached remote statuses as Mastodon statuses rendered for the viewer, in the
 * order given: author, preview card, the viewer's poll votes, local accounts'
 * favourites and boosts with the viewer's own, whether the viewer may quote
 * it, its quote, and reply refs. A status with
 * media is marked sensitive when an admin marked its author's media sensitive,
 * as Mastodon does for a remote account. A status whose author is not cached,
 * or whose author's presentation `authors` refuses, is left out; an author
 * that is not shown renders stripped. The statuses themselves get no
 * visibility check here; a quoted one the viewer may not see is `unauthorized`.
 */
export const mastodonRemoteStatuses = (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<RemoteStatusValue>,
  viewerId: string | undefined,
  authors: StatusAuthors = StatusAuthors.available,
): Promise<Result<ApiOriginalStatusJSON[], RepositoryError>> =>
  renderRemoteStatuses(env, identity, statuses, viewerId, authors, fullQuoteRenderer);

/**
 * {@link mastodonRemoteStatuses} for statuses shown inside another's quote,
 * as Mastodon's `ShallowStatusSerializer`: each one's own quote by id only.
 */
export const mastodonShallowRemoteStatuses = (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<RemoteStatusValue>,
  viewerId: string | undefined,
): Promise<Result<ApiQuotedStatusJSON[], RepositoryError>> =>
  renderRemoteStatuses(
    env,
    identity,
    statuses,
    viewerId,
    StatusAuthors.available,
    shallowQuoteRenderer,
  );
