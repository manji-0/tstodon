import type {
  ApiAccountJSON,
  ApiMediaAttachmentJSON,
  ApiOriginalStatusJSON,
  ApiPreviewCardJSON,
  ApiQuotedStatusJSON,
  ApiShallowQuoteJSON,
  ApiStatusJSON,
} from "@tstodon/api";
import {
  InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  LocalStatus,
  QuoteInteractionPolicy,
  StatusTarget,
  type StatusTargetValue,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { type PresentedAccount, presentedAccounts } from "./account-documents";
import { boostedStatusAuthors, StatusAuthors } from "./account-presentation";
import { findAccountsByIds } from "./account-store";
import { findPollsByStatusIds, type PollRecord } from "./poll-store";
import {
  findQuotesByQuoting,
  findStatusQuotePolicies,
  quoteCountsByQuoted,
  type QuotePolicy,
} from "./quote-store";
import { listStatusMentions } from "./mention-store";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { mastodonRemoteStatuses, mastodonShallowRemoteStatuses } from "./remote-status-documents";
import {
  isQuotedStatusShown,
  mastodonQuote,
  mastodonShallowQuote,
  type QuotedDocument,
} from "./quote-document";
import { quotedStatusAccess } from "./quoted-status-access";
import { findRemoteStatusesByIds, findRemoteStatusRefsByObjectUris } from "./remote-status-store";
import { findStatusesByIds, listStatusReplyUris } from "./status-store";
import { listStatusCards } from "./status-card-store";
import { followingAccountIds } from "./follow-store";
import {
  type StatusInteractionCounts,
  statusInteractionCountsByIds,
} from "./status-interaction-store";
import { findMediaByIds, type MediaRow } from "./media-store";
import { type CustomEmoji, customEmojiJson, emojisInTexts } from "./emoji";
import { sensitizedAccountIds } from "./account-flag-store";
import { loadCustomEmojis } from "./custom-emoji-store";
import { listStatusMuteRoots, resolveThreadRootStatusIds } from "./status-mute-store";
import { cardDocument, parseCardJson } from "./link-card";
import { mastodonMedia } from "./media-document";
import { pollJson } from "./poll-document";
import { noteQuotePolicy, quoteInteractionPolicy } from "./quote-policy-name";
import { documentsById } from "./documents-by-id";
import type { RepositoryError } from "./d1";

const mediaAttachmentsJson = (
  identity: InstanceIdentity,
  mediaIds: ReadonlyArray<string>,
  mediaById: ReadonlyMap<string, MediaRow>,
): ApiMediaAttachmentJSON[] => {
  const media: ApiMediaAttachmentJSON[] = [];
  for (const mediaId of mediaIds) {
    const row = mediaById.get(mediaId);
    if (!row) {
      continue;
    }
    media.push(mastodonMedia(identity, row));
  }
  return media;
};

const buildLocalNoteDocument = (
  identity: InstanceIdentity,
  status: LocalNote,
  account: LocalAccount,
  accountDoc: ApiAccountJSON,
  interactions: StatusInteractionCounts,
  poll: PollRecord | undefined,
  mediaById: ReadonlyMap<string, MediaRow>,
  parentAccountId: string | null,
  emojis: ReadonlyArray<CustomEmoji>,
  muted: boolean,
  sensitized: boolean,
  card: ApiPreviewCardJSON | null,
): ApiOriginalStatusJSON => {
  const url = `${InstanceIdentity.actorUrl(identity, account.username)}/statuses/${status.id}`;
  const attachments = mediaAttachmentsJson(identity, status.mediaIds, mediaById);
  return {
    id: status.id,
    created_at: status.createdAt,
    in_reply_to_id: status.inReplyToId,
    in_reply_to_account_id: parentAccountId,
    sensitive: status.sensitive || (sensitized && attachments.length > 0),
    spoiler_text: status.spoilerText,
    visibility: Visibility.toMastodon(status.visibility),
    language: status.language.kind === "Present" ? status.language.value : null,
    uri: url,
    url,
    replies_count: 0,
    reblogs_count: interactions.reblogs,
    favourites_count: interactions.favourites,
    edited_at: status.editedAt,
    favourited: interactions.favourited,
    reblogged: interactions.reblogged,
    muted,
    bookmarked: interactions.bookmarked,
    content: status.contentHtml,
    reblog: null,
    account: accountDoc,
    media_attachments: attachments,
    mentions: [],
    tags: [],
    emojis: emojis.map(customEmojiJson),
    card,
    poll: poll ? pollJson(poll) : null,
    quote: null,
    quotes_count: 0,
    quote_approval: { automatic: [], manual: [], current_user: "denied" },
    // Mastodon 4.7 collections; none are kept here.
    tagged_collections: [],
  };
};

export const mastodonStatus = async (
  env: Env,
  identity: InstanceIdentity,
  status: LocalStatus,
  viewerId: string | undefined,
  authors: StatusAuthors = StatusAuthors.available,
): Promise<Result<ApiStatusJSON | undefined, RepositoryError>> =>
  (await mastodonStatuses(env, identity, [status], viewerId, authors)).map(
    (documents) => documents[0],
  );

/**
 * Local statuses as Mastodon statuses rendered for the viewer, in the order
 * given. A status whose author's presentation `authors` refuses is left out,
 * as is a boost whose booster it refuses; a boost wraps a suspended author's
 * status with the author stripped, and a quote of an unavailable author's
 * status, or of one the viewer may not see, is `unauthorized`, and one of an
 * author the viewer blocks or mutes is labelled so, as Mastodon's
 * `StatusFilter` renders it.
 */
export const mastodonStatuses = async (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<LocalStatus>,
  viewerId: string | undefined,
  authors: StatusAuthors = StatusAuthors.available,
): Promise<Result<ApiStatusJSON[], RepositoryError>> =>
  statuses.length === 0
    ? ok([])
    : (await renderLocalStatuses(env, identity, statuses, viewerId, authors)).map(
        ({ documents }) => documents,
      );

/**
 * {@link mastodonStatuses} for local statuses shown inside another's quote,
 * as Mastodon's `ShallowStatusSerializer`: each one's own quote by id only,
 * which ends the nesting. A boost is never quoted, so boosts are left out.
 */
export const mastodonShallowStatuses = async (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<LocalStatus>,
  viewerId: string | undefined,
): Promise<Result<ApiQuotedStatusJSON[], RepositoryError>> =>
  statuses.length === 0
    ? ok([])
    : (await renderLocalStatuses(env, identity, statuses, viewerId, StatusAuthors.available)).map(
        ({ shallow }) =>
          statuses.flatMap((status) => {
            const document = shallow(status);
            return document ? [document] : [];
          }),
      );

/** The statuses rendered in full, and how each renders shown inside a quote. */
const renderLocalStatuses = async (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<LocalStatus>,
  viewerId: string | undefined,
  authors: StatusAuthors,
): Promise<
  Result<
    Readonly<{
      documents: ApiStatusJSON[];
      shallow: (status: LocalStatus) => ApiQuotedStatusJSON | undefined;
    }>,
    RepositoryError
  >
> => {
  const instanceEmojis = await loadCustomEmojis(env, identity.mediaPublicBaseUrl);

  const byId = new Map<string, LocalStatus>(statuses.map((status) => [status.id, status]));

  // Resolve reblog targets (including reblog-of-reblog) and reply parents.
  for (let pass = 0; pass < 4; pass += 1) {
    // The status each loaded one points at: a boost's local target, a note's parent.
    const pointedAt = (status: LocalStatus): string | null =>
      status.kind === "LocalReblog"
        ? status.target.kind === "LocalStatus"
          ? status.target.statusId
          : null
        : status.inReplyToId;
    const missing = new Set(
      [...byId.values()].flatMap((status) => {
        const id = pointedAt(status);
        return id && id.length > 0 && !byId.has(id) ? [id] : [];
      }),
    );
    if (missing.size === 0) {
      break;
    }
    const loaded = await findStatusesByIds(env.DB, [...missing]);
    if (loaded.isErr()) {
      break;
    }
    let added = 0;
    for (const [id, status] of loaded.value) {
      if (!byId.has(id)) {
        byId.set(id, status);
        added += 1;
      }
    }
    if (added === 0) {
      break;
    }
  }

  // Quotes point at another note; load the quoted statuses so the quote can be
  // rendered, then read every quote of the loaded notes.
  const noteIdsOf = (statuses: Iterable<LocalStatus>): string[] =>
    [...statuses].filter(LocalStatus.isNote).map((status) => status.id);
  const noteTargetsOf = (statuses: Iterable<LocalStatus>) =>
    [...statuses].filter(LocalStatus.isNote).map((status) => StatusTarget.local(status.id));
  const loadQuotes = async (statuses: Iterable<LocalStatus>) => {
    const result = await findQuotesByQuoting(env.DB, noteTargetsOf(statuses));
    return result.isOk() ? result.value : new Map<string, never>();
  };
  let quotes = await loadQuotes(byId.values());
  const quotedMissing = [
    ...new Set(
      [...quotes.values()].flatMap(({ quoted }) =>
        quoted.kind === "LocalStatus" ? [quoted.statusId] : [],
      ),
    ),
  ].filter((id) => !byId.has(id));
  if (quotedMissing.length > 0) {
    const loaded = await findStatusesByIds(env.DB, quotedMissing);
    for (const [id, status] of loaded.isOk() ? loaded.value : []) {
      byId.set(id, status);
    }
  }
  quotes = await loadQuotes(byId.values());
  // A quoted status shows its own quote by id, under the state the viewer
  // sees it in: load the local statuses those quotes name too.
  const nestedMissing = [
    ...new Set(
      [...quotes.values()].flatMap(({ quoted }) =>
        quoted.kind === "LocalStatus" && !byId.has(quoted.statusId) ? [quoted.statusId] : [],
      ),
    ),
  ];
  if (nestedMissing.length > 0) {
    const loaded = await findStatusesByIds(env.DB, nestedMissing);
    for (const [id, status] of loaded.isOk() ? loaded.value : []) {
      byId.set(id, status);
    }
    quotes = await loadQuotes(byId.values());
  }

  const allStatuses = [...byId.values()];
  const accountIds = [...new Set(allStatuses.map((status) => status.accountId))];
  const noteIds = allStatuses.filter(LocalStatus.isNote).map((status) => status.id);
  const mediaIds = [
    ...new Set(
      allStatuses.flatMap((status) => (status.kind === "LocalNote" ? [...status.mediaIds] : [])),
    ),
  ];

  const [
    accountsResult,
    interactionsResult,
    pollsResult,
    mediaResult,
    sensitizedResult,
    cardsResult,
  ] = await Promise.all([
    findAccountsByIds(env.DB, accountIds),
    statusInteractionCountsByIds(env.DB, noteIds, viewerId),
    findPollsByStatusIds(env.DB, noteIds, viewerId),
    findMediaByIds(env.DB, mediaIds),
    sensitizedAccountIds(env.DB, accountIds),
    listStatusCards(env.DB, noteIds),
  ]);

  if (accountsResult.isErr()) {
    return err(accountsResult.error);
  }
  const accounts = accountsResult.value;
  const interactions = interactionsResult.isOk()
    ? interactionsResult.value
    : new Map<string, StatusInteractionCounts>();
  const polls = pollsResult.isOk() ? pollsResult.value : new Map<string, PollRecord>();
  const mediaById = mediaResult.isOk() ? mediaResult.value : new Map<string, MediaRow>();
  const sensitizedIds = sensitizedResult.isOk() ? sensitizedResult.value : new Set<string>();
  const cards = new Map(
    [...(cardsResult.isOk() ? cardsResult.value : [])].flatMap(
      ([statusId, raw]): [string, ApiPreviewCardJSON][] => {
        const card = parseCardJson(raw);
        return card ? [[statusId, cardDocument(card)]] : [];
      },
    ),
  );

  const [presented, quoteCountsResult, policiesResult] = await Promise.all([
    presentedAccounts(env, identity, [...accounts.values()], []),
    quoteCountsByQuoted(env.DB, noteTargetsOf(allStatuses)),
    findStatusQuotePolicies(env.DB, noteIdsOf(allStatuses)),
  ]);
  if (presented.isErr()) {
    return err(presented.error);
  }
  const authorOf = (status: LocalStatus): PresentedAccount | undefined =>
    presented.value.get(status.accountId);
  const quoteCounts = quoteCountsResult.isOk()
    ? quoteCountsResult.value
    : new Map<string, number>();
  const quotePolicies = policiesResult.isOk()
    ? policiesResult.value
    : new Map<string, QuotePolicy>();
  const viewerFollowing = viewerId ? await followingAccountIds(env.DB, viewerId) : undefined;
  const followedByIds = viewerFollowing?.isOk() ? viewerFollowing.value : new Set<string>();

  const noteDocs = new Map<string, ApiOriginalStatusJSON>();
  const mutedRoots = viewerId ? await listStatusMuteRoots(env.DB, viewerId) : undefined;
  const mutedSet = mutedRoots?.isOk() ? mutedRoots.value : new Set<string>();
  const threadRoots =
    mutedSet.size > 0 ? await resolveThreadRootStatusIds(env.DB, allStatuses) : undefined;
  const rootById = threadRoots?.isOk() ? threadRoots.value : undefined;
  for (const status of allStatuses) {
    if (status.kind !== "LocalNote") {
      continue;
    }
    const account = accounts.get(status.accountId);
    const author = authorOf(status);
    if (!account || !author) {
      continue;
    }
    const parent = status.inReplyToId ? byId.get(status.inReplyToId) : undefined;
    const root = rootById?.get(status.id);
    noteDocs.set(
      status.id,
      buildLocalNoteDocument(
        identity,
        status,
        account,
        author.document,
        interactions.get(status.id) ?? {
          favourites: 0,
          reblogs: 0,
          favourited: false,
          reblogged: false,
          bookmarked: false,
        },
        polls.get(status.id),
        mediaById,
        parent?.accountId ?? null,
        emojisInTexts([status.text, status.spoilerText], instanceEmojis),
        root !== undefined && mutedSet.has(root),
        sensitizedIds.has(status.accountId),
        cards.get(status.id) ?? null,
      ),
    );
  }

  // A reply to a cached remote status names it by URI; render its id and author.
  const replyUris = await listStatusReplyUris(env.DB, [...noteDocs.keys()]);
  if (replyUris.isOk() && replyUris.value.size > 0) {
    const parents = await findRemoteStatusRefsByObjectUris(env.DB, [...replyUris.value.values()]);
    for (const [statusId, uri] of replyUris.value) {
      const parent = parents.isOk() ? parents.value.get(uri) : undefined;
      const document = noteDocs.get(statusId);
      if (parent && document) {
        document.in_reply_to_id = parent.id;
        document.in_reply_to_account_id = RemoteAccountId.encode(parent.actorUri);
      }
    }
  }

  // Mentions render as Mastodon's Mention entities, local and remote alike.
  const mentionsResult = await listStatusMentions(env.DB, [...noteDocs.keys()]);
  const mentions = mentionsResult.isOk()
    ? mentionsResult.value
    : new Map<string, { accountIds: ReadonlyArray<string>; actorUris: ReadonlyArray<string> }>();
  const mentionedLocalIds = [...mentions.values()].flatMap((entry) => entry.accountIds);
  const [mentionedLocals, mentionedActors] = await Promise.all([
    findAccountsByIds(
      env.DB,
      mentionedLocalIds.filter((id) => !accounts.has(id)),
    ),
    findRemoteActorsByUris(
      env.DB,
      [...mentions.values()].flatMap((entry) => entry.actorUris),
    ),
  ]);
  const mentionedAccount = (id: string): LocalAccount | undefined =>
    accounts.get(id) ?? (mentionedLocals.isOk() ? mentionedLocals.value.get(id) : undefined);
  for (const [statusId, entry] of mentions) {
    const document = noteDocs.get(statusId);
    if (!document) {
      continue;
    }
    document.mentions = [
      ...entry.accountIds.flatMap((id) => {
        const account = mentionedAccount(id);
        return account
          ? [
              {
                id: account.id,
                username: account.username,
                url: InstanceIdentity.actorUrl(identity, account.username),
                acct: account.username,
              },
            ]
          : [];
      }),
      ...entry.actorUris.flatMap((actorUri) => {
        const actor = mentionedActors.isOk() ? mentionedActors.value.get(actorUri) : undefined;
        return actor
          ? [
              {
                id: RemoteAccountId.encode(actor.actorUri),
                username: actor.username,
                url: actor.actorUri,
                acct: `${actor.username}@${actor.domain}`,
              },
            ]
          : [];
      }),
    ];
  }

  // Boosts wrap the boosted status as the viewer sees it, a suspended author's
  // too; a quote shows its status only while the viewer may see it and its
  // author is available.
  const boosted = boostedStatusAuthors(authors);
  const boostedRemoteIds = allStatuses.flatMap((status) =>
    status.kind === "LocalReblog" && status.target.kind === "RemoteStatus"
      ? [status.target.statusId]
      : [],
  );
  const quotedRemoteIds = [...quotes.values()].flatMap(({ quoted }) =>
    quoted.kind === "RemoteStatus" ? [quoted.statusId] : [],
  );
  const remoteTargets = await findRemoteStatusesByIds(env.DB, [
    ...new Set([...boostedRemoteIds, ...quotedRemoteIds]),
  ]);
  if (remoteTargets.isErr()) {
    return err(remoteTargets.error);
  }
  const remotesOf = (ids: ReadonlyArray<string>) =>
    ids.flatMap((id) => {
      const status = remoteTargets.value.get(id);
      return status ? [status] : [];
    });
  const quotedLocals = [...quotes.values()].flatMap(({ quoted }) => {
    const status = quoted.kind === "LocalStatus" ? byId.get(quoted.statusId) : undefined;
    return status ? [status] : [];
  });
  const quotedAccess = await quotedStatusAccess(
    env.DB,
    quotedLocals,
    remotesOf(quotedRemoteIds),
    viewerId,
  );
  if (quotedAccess.isErr()) {
    return err(quotedAccess.error);
  }
  const accessOf = quotedAccess.value;
  const [remoteRendered, quotedRemoteRendered] = await Promise.all([
    mastodonRemoteStatuses(env, identity, remotesOf(boostedRemoteIds), viewerId, boosted),
    mastodonShallowRemoteStatuses(
      env,
      identity,
      remotesOf(quotedRemoteIds).filter((status) =>
        isQuotedStatusShown(accessOf(StatusTarget.remote(status.id))),
      ),
      viewerId,
    ),
  ]);
  if (remoteRendered.isErr()) {
    return err(remoteRendered.error);
  }
  if (quotedRemoteRendered.isErr()) {
    return err(quotedRemoteRendered.error);
  }
  const remoteDocs = documentsById(remoteRendered.value);
  const quotedRemoteDocs = documentsById(quotedRemoteRendered.value);
  // A local status shown inside a quote shows its own quote by id only, as
  // Mastodon's `ShallowQuoteSerializer`, which ends the nesting.
  const shallowQuoteOf = (statusId: string): ApiShallowQuoteJSON | null => {
    const quote = quotes.get(statusId);
    if (!quote) {
      return null;
    }
    const { quoted } = quote;
    return mastodonShallowQuote(
      quote.state,
      quoted.kind === "Unresolved" ? null : quoted.statusId,
      () => (quoted.kind === "Unresolved" ? "Gone" : accessOf(quoted)),
    );
  };
  const shallowLocalDocument = (statusId: string): ApiQuotedStatusJSON | undefined => {
    const document = noteDocs.get(statusId);
    return document && { ...document, quote: shallowQuoteOf(statusId) };
  };
  const quotedDocument = (quoted: StatusTargetValue): QuotedDocument => {
    const access = accessOf(quoted);
    if (access === "Gone") {
      return undefined;
    }
    if (!isQuotedStatusShown(access)) {
      return "Unauthorized";
    }
    const local = quoted.kind === "LocalStatus" ? byId.get(quoted.statusId) : undefined;
    const author = local && authorOf(local);
    const document =
      quoted.kind === "RemoteStatus"
        ? quotedRemoteDocs.get(quoted.statusId)
        : author && StatusAuthors.available(author.presentation)
          ? shallowLocalDocument(quoted.statusId)
          : undefined;
    return document ? { access, document } : "Unauthorized";
  };

  for (const status of allStatuses) {
    if (status.kind !== "LocalNote") {
      continue;
    }
    const document = noteDocs.get(status.id);
    const account = accounts.get(status.accountId);
    if (!document || !account) {
      continue;
    }
    const quote = quotes.get(status.id);
    if (quote) {
      const { quoted } = quote;
      document.quote = mastodonQuote(quote.state, () =>
        quoted.kind === "Unresolved" ? undefined : quotedDocument(quoted),
      );
    }
    document.quotes_count = quoteCounts.get(status.id) ?? 0;
    const policy = quoteInteractionPolicy(
      noteQuotePolicy(account, status, quotePolicies.get(status.id)),
    );
    document.quote_approval = {
      automatic: policy.automatic,
      manual: policy.manual,
      current_user: QuoteInteractionPolicy.forViewer(
        policy,
        status.visibility,
        viewerId === undefined
          ? undefined
          : {
              viewerIsAuthor: viewerId === status.accountId,
              viewerFollowsAuthor: followedByIds.has(status.accountId),
              // A local policy never names the author's `following`.
              authorFollowsViewer: false,
            },
      ),
    };
  }

  const renderNote = (
    status: LocalStatus,
    rule: StatusAuthors,
  ): ApiOriginalStatusJSON | undefined => {
    const author = authorOf(status);
    return author && rule(author.presentation) && status.kind === "LocalNote"
      ? noteDocs.get(status.id)
      : undefined;
  };
  const render = (status: LocalStatus, rule: StatusAuthors): ApiStatusJSON | undefined => {
    const author = authorOf(status);
    if (!author || !rule(author.presentation)) {
      return undefined;
    }
    if (status.kind === "LocalNote") {
      return noteDocs.get(status.id);
    }
    const local = byId.get(status.target.statusId);
    // A boost wraps an original status; boosting a boost boosts its original.
    const wrapped =
      status.target.kind === "RemoteStatus"
        ? remoteDocs.get(status.target.statusId)
        : local && renderNote(local, boosted);
    if (!wrapped) {
      return undefined;
    }
    return {
      ...wrapped,
      id: status.id,
      reblog: wrapped,
      account: author.document,
      created_at: status.createdAt,
      // The boost's own visibility, which may be narrower than the original's.
      visibility: Visibility.toMastodon(status.visibility),
    };
  };

  return ok({
    documents: statuses.flatMap((status) => {
      const document = render(status, authors);
      return document ? [document] : [];
    }),
    shallow: (status) =>
      renderNote(status, StatusAuthors.available) && shallowLocalDocument(status.id),
  });
};
