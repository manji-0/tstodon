import {
  InstanceIdentity,
  type LocalAccount,
  type LocalNote,
  type LocalStatus,
  Visibility,
} from "@tstodon/domain";
import { type AccountCounts, accountCountsByIds, findAccountsByIds } from "./account-store";
import { findPollsByStatusIds, type PollRecord } from "./poll-store";
import {
  findQuotesByStatusIds,
  findStatusQuotePolicies,
  quoteCountsByStatusIds,
  type QuotePolicy,
} from "./quote-store";
import { listStatusMentions } from "./mention-store";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemoteStatusRefsByObjectUris } from "./remote-status-store";
import { findStatusesByIds, listStatusReplyUris } from "./status-store";
import { listStatusCards } from "./status-card-store";
import { followingAccountIds } from "./follow-store";
import {
  type StatusInteractionCounts,
  statusInteractionCountsByIds,
} from "./status-interaction-store";
import { findMediaByIds, type MediaRow } from "./media-store";
import { type CustomEmoji, customEmojiJson, emojisInText, emojisInTexts } from "./emoji";
import {
  type AccountProfile,
  EMPTY_ACCOUNT_PROFILE,
  listAccountProfiles,
} from "./account-profile-store";
import { sensitizedAccountIds } from "./account-flag-store";
import { loadCustomEmojis } from "./custom-emoji-store";
import { listStatusMuteRoots, resolveThreadRootStatusIds } from "./status-mute-store";
import { cardDocument, parseCardJson } from "./link-card";
import { mastodonAccount } from "./account-documents";
import { mastodonMedia } from "./media-document";
import { pollJson } from "./poll-document";
import { quotePolicyName } from "./quote-policy-name";

const mediaAttachmentsJson = (
  identity: InstanceIdentity,
  mediaIds: ReadonlyArray<string>,
  mediaById: ReadonlyMap<string, MediaRow>,
): Record<string, unknown>[] => {
  const media: Record<string, unknown>[] = [];
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
  accountDoc: Record<string, unknown>,
  interactions: StatusInteractionCounts,
  poll: PollRecord | undefined,
  mediaById: ReadonlyMap<string, MediaRow>,
  parentAccountId: string | null,
  emojis: ReadonlyArray<CustomEmoji>,
  muted: boolean,
  sensitized: boolean,
  card: Record<string, unknown> | null,
): Record<string, unknown> => {
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
    quote_approval: { automatic: [], manual: [], current_user: "unknown" },
  };
};

export const mastodonStatus = async (
  env: Env,
  identity: InstanceIdentity,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const documents = await mastodonStatuses(env, identity, [status], viewerId);
  return documents[0];
};

export const mastodonStatuses = async (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<LocalStatus>,
  viewerId: string | undefined,
): Promise<Record<string, unknown>[]> => {
  if (statuses.length === 0) {
    return [];
  }

  const instanceEmojis = await loadCustomEmojis(env, identity.mediaPublicBaseUrl);

  const byId = new Map<string, LocalStatus>();
  for (const status of statuses) {
    byId.set(status.id, status);
  }

  // Resolve reblog targets (including reblog-of-reblog) and reply parents.
  for (let pass = 0; pass < 4; pass += 1) {
    const missing = new Set<string>();
    for (const status of byId.values()) {
      if (status.kind === "LocalReblog" && !byId.has(status.reblogOfId)) {
        missing.add(status.reblogOfId);
      }
      if (
        status.kind === "LocalNote" &&
        status.inReplyToId &&
        status.inReplyToId.length > 0 &&
        !byId.has(status.inReplyToId)
      ) {
        missing.add(status.inReplyToId);
      }
    }
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
    [...statuses]
      .filter((status): status is LocalNote => status.kind === "LocalNote")
      .map((status) => status.id);
  const loadQuotes = async (ids: ReadonlyArray<string>) => {
    const result = await findQuotesByStatusIds(env.DB, ids);
    return result.isOk() ? result.value : new Map<string, never>();
  };
  let quotes = await loadQuotes(noteIdsOf(byId.values()));
  const quotedMissing = [
    ...new Set([...quotes.values()].map((quote) => quote.quotedStatusId)),
  ].filter((id) => !byId.has(id));
  if (quotedMissing.length > 0) {
    const loaded = await findStatusesByIds(env.DB, quotedMissing);
    if (loaded.isOk()) {
      for (const [id, status] of loaded.value) {
        byId.set(id, status);
      }
    }
  }
  quotes = await loadQuotes(noteIdsOf(byId.values()));

  const allStatuses = [...byId.values()];
  const accountIds = [...new Set(allStatuses.map((status) => status.accountId))];
  const noteIds = allStatuses
    .filter((status): status is LocalNote => status.kind === "LocalNote")
    .map((status) => status.id);
  const mediaIds = [
    ...new Set(
      allStatuses.flatMap((status) => (status.kind === "LocalNote" ? [...status.mediaIds] : [])),
    ),
  ];

  const [
    accountsResult,
    countsResult,
    interactionsResult,
    pollsResult,
    mediaResult,
    sensitizedResult,
    profilesResult,
    cardsResult,
  ] = await Promise.all([
    findAccountsByIds(env.DB, accountIds),
    accountCountsByIds(env.DB, accountIds),
    statusInteractionCountsByIds(env.DB, noteIds, viewerId),
    findPollsByStatusIds(env.DB, noteIds, viewerId),
    findMediaByIds(env.DB, mediaIds),
    sensitizedAccountIds(env.DB, accountIds),
    listAccountProfiles(env.DB, accountIds),
    listStatusCards(env.DB, noteIds),
  ]);

  const accounts = accountsResult.isOk() ? accountsResult.value : new Map<string, LocalAccount>();
  const accountCountsMap = countsResult.isOk()
    ? countsResult.value
    : new Map<string, AccountCounts>();
  const interactions = interactionsResult.isOk()
    ? interactionsResult.value
    : new Map<string, StatusInteractionCounts>();
  const polls = pollsResult.isOk() ? pollsResult.value : new Map<string, PollRecord>();
  const mediaById = mediaResult.isOk() ? mediaResult.value : new Map<string, MediaRow>();
  const sensitizedIds = sensitizedResult.isOk() ? sensitizedResult.value : new Set<string>();
  const profiles = profilesResult.isOk() ? profilesResult.value : new Map<string, AccountProfile>();
  const cards = new Map<string, Record<string, unknown>>();
  if (cardsResult.isOk()) {
    for (const [statusId, raw] of cardsResult.value) {
      const card = parseCardJson(raw);
      if (card) {
        cards.set(statusId, cardDocument(card));
      }
    }
  }

  const accountDocs = new Map<string, Record<string, unknown>>();
  for (const [id, account] of accounts) {
    accountDocs.set(
      id,
      mastodonAccount(
        identity,
        account,
        accountCountsMap.get(id) ?? { followers: 0, following: 0, statuses: 0 },
        emojisInText(account.displayName, instanceEmojis),
        profiles.get(id) ?? EMPTY_ACCOUNT_PROFILE,
      ),
    );
  }

  const quoteCountsResult = await quoteCountsByStatusIds(env.DB, noteIdsOf(allStatuses));
  const quoteCounts = quoteCountsResult.isOk()
    ? quoteCountsResult.value
    : new Map<string, number>();
  const policiesResult = await findStatusQuotePolicies(env.DB, noteIdsOf(allStatuses));
  const quotePolicies = policiesResult.isOk()
    ? policiesResult.value
    : new Map<string, QuotePolicy>();
  const viewerFollowing = viewerId ? await followingAccountIds(env.DB, viewerId) : undefined;
  const followedByIds = viewerFollowing?.isOk() ? viewerFollowing.value : new Set<string>();

  const noteDocs = new Map<string, Record<string, unknown>>();
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
    const accountDoc = accountDocs.get(status.accountId);
    if (!account || !accountDoc) {
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
        accountDoc,
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
      const target = noteDocs.get(quote.quotedStatusId);
      const state = quote.state === "revoked" ? "revoked" : target ? "accepted" : "deleted";
      document.quote = {
        state,
        quoted_status: state === "accepted" ? (target ?? null) : null,
      };
    }
    document.quotes_count = quoteCounts.get(status.id) ?? 0;
    const policy = quotePolicies.get(status.id) ?? quotePolicyName(account.defaultQuotePolicy);
    document.quote_approval = {
      automatic: [],
      manual: [],
      current_user:
        viewerId === undefined
          ? "unknown"
          : viewerId === status.accountId ||
              policy === "public" ||
              (policy === "followers" && followedByIds.has(status.accountId))
            ? "automatic"
            : "denied",
    };
  }

  const render = (status: LocalStatus): Record<string, unknown> | undefined => {
    if (status.kind === "LocalNote") {
      return noteDocs.get(status.id);
    }
    const accountDoc = accountDocs.get(status.accountId);
    const target = byId.get(status.reblogOfId);
    if (!accountDoc || !target) {
      return undefined;
    }
    const wrapped = render(target);
    if (!wrapped) {
      return undefined;
    }
    return {
      ...wrapped,
      id: status.id,
      reblog: wrapped,
      account: accountDoc,
      created_at: status.createdAt,
      // The boost's own visibility, which may be narrower than the original's.
      visibility: Visibility.toMastodon(status.visibility),
    };
  };

  const documents: Record<string, unknown>[] = [];
  for (const status of statuses) {
    const document = render(status);
    if (document) {
      documents.push(document);
    }
  }
  return documents;
};
