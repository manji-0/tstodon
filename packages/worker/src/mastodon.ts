import {
  InstanceIdentity,
  Visibility,
  type LocalAccount,
  type LocalNote,
  type LocalStatus,
  type RemoteActor,
  type RemoteStatus as RemoteStatusValue,
} from "@tstodon/domain";
import {
  accountCounts,
  accountCountsByIds,
  findAccountById,
  findAccountsByIds,
  type AccountCounts,
} from "./account-store";
import { findPollsByStatusIds, type PollRecord } from "./poll-store";
import { RemoteAccountId } from "./remote-account-id";
import { findStatusById, findStatusesByIds, listStatusCards } from "./status-store";
import {
  statusInteractionCountsByIds,
  type NotificationRow,
  type RelationshipFlags,
  type StatusInteractionCounts,
} from "./social-store";
import { findMediaByIds, type MediaRow } from "./media-store";
import { customEmojiJson, emojisInText, emojisInTexts, type CustomEmoji } from "./emoji";
import {
  EMPTY_ACCOUNT_PROFILE,
  findAccountProfile,
  listAccountProfiles,
  type AccountProfile,
} from "./account-profile-store";
import { sensitizedAccountIds } from "./account-flag-store";
import { loadCustomEmojis } from "./custom-emoji-store";
import { listStatusMuteRoots, resolveThreadRootStatusIds } from "./status-mute-store";
import { textToHtml } from "./html";
import { cardDocument, parseCardJson } from "./link-card";
import { FilterContextSchema, parseJsonColumn } from "./schemas";
import { filterKeywords, type FilterRow } from "./moderation-store";

const mediaUrl = (identity: InstanceIdentity, objectKey: string): string =>
  `${identity.mediaPublicBaseUrl.replace(/\/$/, "")}/${objectKey}`;

export const mastodonAccount = (
  identity: InstanceIdentity,
  account: LocalAccount,
  counts: { followers: number; following: number; statuses: number },
  emojis: ReadonlyArray<CustomEmoji> = [],
  profile: AccountProfile = EMPTY_ACCOUNT_PROFILE,
): Record<string, unknown> => {
  const url = InstanceIdentity.actorUrl(identity, account.username);
  return {
    id: account.id,
    username: account.username,
    acct: `${account.username}`,
    display_name: account.displayName,
    locked: account.locked,
    bot: profile.bot,
    discoverable: profile.discoverable,
    group: false,
    created_at: account.createdAt,
    note: textToHtml(profile.note),
    url,
    uri: url,
    avatar: profile.avatarObjectKey
      ? mediaUrl(identity, profile.avatarObjectKey)
      : identity.thumbnailUrl,
    avatar_static: profile.avatarObjectKey
      ? mediaUrl(identity, profile.avatarObjectKey)
      : identity.thumbnailUrl,
    header: profile.headerObjectKey
      ? mediaUrl(identity, profile.headerObjectKey)
      : identity.thumbnailUrl,
    header_static: profile.headerObjectKey
      ? mediaUrl(identity, profile.headerObjectKey)
      : identity.thumbnailUrl,
    followers_count: counts.followers,
    following_count: counts.following,
    statuses_count: counts.statuses,
    last_status_at: null,
    emojis: emojis.map(customEmojiJson),
    fields: profile.fields.map((field) => ({
      name: field.name,
      value: field.value,
      verified_at: null,
    })),
  };
};

export const mastodonAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Record<string, unknown>> => {
  const [counts, profile] = await Promise.all([
    accountCounts(env.DB, account.id),
    findAccountProfile(env.DB, account.id),
  ]);
  return mastodonAccount(
    identity,
    account,
    counts.isOk() ? counts.value : { followers: 0, following: 0, statuses: 0 },
    emojisInText(account.displayName, await loadCustomEmojis(env, identity.mediaPublicBaseUrl)),
    profile.isOk() ? profile.value : EMPTY_ACCOUNT_PROFILE,
  );
};

export const mastodonRemoteAccount = (
  identity: InstanceIdentity,
  actor: RemoteActor,
): Record<string, unknown> => {
  const url = actor.actorUri;
  return {
    id: RemoteAccountId.encode(actor.actorUri),
    username: actor.username,
    acct: `${actor.username}@${actor.domain}`,
    display_name: actor.displayName,
    locked: false,
    bot: false,
    discoverable: true,
    group: false,
    created_at: actor.fetchedAt,
    note: "",
    url,
    uri: url,
    avatar: identity.thumbnailUrl,
    avatar_static: identity.thumbnailUrl,
    header: identity.thumbnailUrl,
    header_static: identity.thumbnailUrl,
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: null,
    emojis: [],
    fields: [],
  };
};

export const mastodonRemoteStatus = (
  identity: InstanceIdentity,
  status: RemoteStatusValue,
  actor: RemoteActor,
): Record<string, unknown> => {
  const url = status.url ?? status.objectUri;
  return {
    id: status.id,
    created_at: status.publishedAt,
    in_reply_to_id: null,
    in_reply_to_account_id: null,
    sensitive: status.sensitive,
    spoiler_text: status.spoilerText,
    visibility: Visibility.toMastodon(status.visibility),
    language: status.language.kind === "Present" ? status.language.value : null,
    uri: status.objectUri,
    url,
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
    edited_at: null,
    favourited: false,
    reblogged: false,
    muted: false,
    bookmarked: false,
    content: status.contentHtml,
    reblog: null,
    account: mastodonRemoteAccount(identity, actor),
    media_attachments: status.media.map((attachment, index) => ({
      id: `${status.id}-${index}`,
      type: remoteMediaType(attachment.mediaType),
      url: attachment.url,
      preview_url: attachment.url,
      remote_url: attachment.url,
      text_url: attachment.url,
      meta: {},
      description: attachment.description.length > 0 ? attachment.description : null,
      blurhash: null,
    })),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  };
};

const remoteMediaType = (mediaType: string): string => {
  const type = mediaType.toLowerCase();
  if (type.length === 0) {
    return "unknown";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  if (type.startsWith("image/")) {
    return "image";
  }
  return "unknown";
};

export const remoteStatusVisible = (status: RemoteStatusValue): boolean =>
  status.visibility.kind === "Public" || status.visibility.kind === "Unlisted";

export const pollJson = (poll: PollRecord): Record<string, unknown> => {
  const expired = Date.parse(poll.expiresAt) <= Date.now();
  // A poll that hides totals keeps them secret until it ends.
  const hidden = poll.hideTotals && !expired;
  return {
    id: poll.id,
    expires_at: poll.expiresAt,
    expired,
    multiple: poll.multiple,
    votes_count: hidden ? null : poll.options.reduce((sum, option) => sum + option.votesCount, 0),
    voters_count: hidden || !poll.multiple ? null : poll.votedIndexes.length,
    voted: poll.votedIndexes.length > 0,
    own_votes: [...poll.votedIndexes],
    options: poll.options.map((option) => ({
      title: option.title,
      votes_count: hidden ? null : option.votesCount,
    })),
    emojis: [],
  };
};

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

export const mastodonRelationship = (
  targetId: string,
  flags: RelationshipFlags,
): Record<string, unknown> => ({
  id: targetId,
  following: flags.following,
  showing_reblogs: flags.following,
  notifying: false,
  followed_by: flags.followedBy,
  blocking: flags.blocking,
  blocked_by: flags.blockedBy,
  muting: flags.muting,
  muting_notifications: flags.mutingNotifications,
  muting_expires_at: flags.mutingExpiresAt,
  requested: flags.requested,
  domain_blocking: flags.domainBlocking,
  endorsed: flags.endorsed,
  note: flags.note,
});

export const mastodonNotification = async (
  env: Env,
  identity: InstanceIdentity,
  row: NotificationRow,
  viewerId: string,
): Promise<Record<string, unknown> | undefined> => {
  const from = await findAccountById(env.DB, row.from_account_id);
  if (from.isErr() || !from.value) {
    return undefined;
  }
  const account = await mastodonAccountDocument(env, identity, from.value);
  let status: Record<string, unknown> | null = null;
  if (row.status_id) {
    const found = await findStatusById(env.DB, row.status_id);
    if (found.isOk() && found.value) {
      status = (await mastodonStatus(env, identity, found.value, viewerId)) ?? null;
    }
  }
  return {
    id: row.id,
    type: row.kind,
    created_at: row.created_at,
    account,
    status,
  };
};

export const mastodonFilter = (row: FilterRow): Record<string, unknown> => {
  const context = parseJsonColumn(FilterContextSchema, row.context_json);
  const contexts = context.isOk() ? context.value : ["home"];
  return {
    id: row.id,
    phrase: row.phrase,
    context: contexts,
    whole_word: row.whole_word === 1,
    irreversible: row.irreversible === 1,
    expires_at: row.expires_at,
  };
};

export const mastodonFilterV2 = (
  row: FilterRow,
  statuses: ReadonlyArray<Record<string, unknown>> = [],
): Record<string, unknown> => {
  const v1 = mastodonFilter(row);
  return {
    id: row.id,
    title: row.phrase,
    context: v1.context,
    expires_at: row.expires_at,
    filter_action: row.irreversible === 1 ? "hide" : "warn",
    statuses,
    keywords: filterKeywords(row).map((keyword) => ({
      id: keyword.id,
      keyword: keyword.keyword,
      whole_word: keyword.whole_word,
    })),
  };
};

export const mastodonMedia = (
  identity: InstanceIdentity,
  row: {
    id: string;
    object_key: string;
    content_type: string;
    description?: string | null;
    focus_x?: number | null;
    focus_y?: number | null;
  },
): Record<string, unknown> => {
  const url = mediaUrl(identity, row.object_key);
  const focus =
    row.focus_x !== null &&
    row.focus_x !== undefined &&
    row.focus_y !== null &&
    row.focus_y !== undefined
      ? { x: row.focus_x, y: row.focus_y }
      : undefined;
  return {
    id: row.id,
    type: row.content_type.startsWith("video/") ? "video" : "image",
    url,
    preview_url: url,
    remote_url: null,
    text_url: url,
    meta: focus ? { focus } : {},
    description: row.description ?? null,
    blurhash: null,
  };
};

export const mastodonTag = (
  identity: InstanceIdentity,
  name: string,
  options: {
    history?: ReadonlyArray<{ day: string; uses: string; accounts: string }>;
    following?: boolean;
    featuring?: boolean;
  } = {},
): Record<string, unknown> => ({
  id: name,
  name,
  url: `https://${identity.domain}/tags/${name}`,
  history: options.history ?? [],
  following: options.following ?? false,
  featuring: options.featuring ?? false,
});

export const mastodonFeaturedTag = (
  identity: InstanceIdentity,
  username: string,
  name: string,
  statusesCount: number,
  lastStatusAt: string | null,
): Record<string, unknown> => ({
  id: name,
  name,
  url: `${identity.publicOrigin.replace(/\/$/, "")}/@${username}/tagged/${name}`,
  statuses_count: statusesCount,
  last_status_at: lastStatusAt,
});

export const unauthorized = () => ({
  error: "This method requires an authenticated user",
});
