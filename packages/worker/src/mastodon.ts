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
import { findStatusById, findStatusesByIds } from "./status-store";
import {
  statusInteractionCountsByIds,
  type NotificationRow,
  type StatusInteractionCounts,
} from "./social-store";
import { findMediaByIds, type MediaRow } from "./media-store";
import { mediaPublicUrl } from "./media-keys";
import { FilterContextSchema, parseJsonColumn } from "./schemas";
import type { FilterRow } from "./moderation-store";

export const mastodonAccount = (
  identity: InstanceIdentity,
  account: LocalAccount,
  counts: { followers: number; following: number; statuses: number },
): Record<string, unknown> => {
  const url = InstanceIdentity.actorUrl(identity, account.username);
  const avatar =
    account.avatarObjectKey.kind === "Present"
      ? mediaPublicUrl(identity, account.avatarObjectKey.value)
      : identity.thumbnailUrl;
  const header =
    account.headerObjectKey.kind === "Present"
      ? mediaPublicUrl(identity, account.headerObjectKey.value)
      : identity.thumbnailUrl;
  return {
    id: account.id,
    username: account.username,
    acct: `${account.username}`,
    display_name: account.displayName,
    locked: account.locked,
    bot: false,
    discoverable: true,
    group: false,
    created_at: account.createdAt,
    note: "",
    url,
    uri: url,
    avatar,
    avatar_static: avatar,
    header,
    header_static: header,
    followers_count: counts.followers,
    following_count: counts.following,
    statuses_count: counts.statuses,
    last_status_at: null,
    emojis: [],
    fields: [],
  };
};

export const mastodonAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Record<string, unknown>> => {
  const counts = await accountCounts(env.DB, account.id);
  return mastodonAccount(
    identity,
    account,
    counts.isOk() ? counts.value : { followers: 0, following: 0, statuses: 0 },
  );
};

export const mastodonRemoteAccount = (
  identity: InstanceIdentity,
  actor: RemoteActor,
): Record<string, unknown> => {
  const url = actor.actorUri;
  return {
    id: actor.actorUri,
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
    media_attachments: [],
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: null,
  };
};

export const remoteStatusVisible = (status: RemoteStatusValue): boolean =>
  status.visibility.kind === "Public" || status.visibility.kind === "Unlisted";

export const pollJson = (poll: PollRecord): Record<string, unknown> => ({
  id: poll.id,
  expires_at: poll.expiresAt,
  expired: Date.parse(poll.expiresAt) <= Date.now(),
  multiple: poll.multiple,
  votes_count: poll.options.reduce((sum, option) => sum + option.votesCount, 0),
  voters_count: poll.votedIndexes.length,
  voted: poll.votedIndexes.length > 0,
  own_votes: [...poll.votedIndexes],
  options: poll.options.map((option) => ({
    title: option.title,
    votes_count: option.votesCount,
  })),
  emojis: [],
});

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
    const url = mediaPublicUrl(identity, row.object_key);
    media.push({
      id: row.id,
      type: row.content_type.startsWith("video/") ? "video" : "image",
      url,
      preview_url: url,
      remote_url: null,
      text_url: url,
      meta: {},
      description: null,
      blurhash: null,
    });
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
): Record<string, unknown> => {
  const url = `${InstanceIdentity.actorUrl(identity, account.username)}/statuses/${status.id}`;
  return {
    id: status.id,
    created_at: status.createdAt,
    in_reply_to_id: status.inReplyToId,
    in_reply_to_account_id: parentAccountId,
    sensitive: status.sensitive,
    spoiler_text: status.spoilerText,
    visibility: Visibility.toMastodon(status.visibility),
    language: status.language.kind === "Present" ? status.language.value : null,
    uri: url,
    url,
    replies_count: 0,
    reblogs_count: interactions.reblogs,
    favourites_count: interactions.favourites,
    edited_at: null,
    favourited: interactions.favourited,
    reblogged: interactions.reblogged,
    muted: false,
    bookmarked: interactions.bookmarked,
    content: status.contentHtml,
    reblog: null,
    account: accountDoc,
    media_attachments: mediaAttachmentsJson(identity, status.mediaIds, mediaById),
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
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

  const [accountsResult, countsResult, interactionsResult, pollsResult, mediaResult] =
    await Promise.all([
      findAccountsByIds(env.DB, accountIds),
      accountCountsByIds(env.DB, accountIds),
      statusInteractionCountsByIds(env.DB, noteIds, viewerId),
      findPollsByStatusIds(env.DB, noteIds, viewerId),
      findMediaByIds(env.DB, mediaIds),
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

  const accountDocs = new Map<string, Record<string, unknown>>();
  for (const [id, account] of accounts) {
    accountDocs.set(
      id,
      mastodonAccount(
        identity,
        account,
        accountCountsMap.get(id) ?? { followers: 0, following: 0, statuses: 0 },
      ),
    );
  }

  const noteDocs = new Map<string, Record<string, unknown>>();
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
  flags: Readonly<{ following: boolean; followedBy: boolean; requested: boolean }>,
): Record<string, unknown> => ({
  id: targetId,
  following: flags.following,
  showing_reblogs: flags.following,
  notifying: false,
  followed_by: flags.followedBy,
  blocking: false,
  blocked_by: false,
  muting: false,
  muting_notifications: false,
  requested: flags.requested,
  domain_blocking: false,
  endorsed: false,
  note: "",
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

export const mastodonFilterV2 = (row: FilterRow): Record<string, unknown> => {
  const v1 = mastodonFilter(row);
  return {
    id: row.id,
    title: row.phrase,
    context: v1.context,
    expires_at: row.expires_at,
    filter_action: row.irreversible === 1 ? "hide" : "warn",
    keywords: [
      {
        id: row.id,
        keyword: row.phrase,
        whole_word: row.whole_word === 1,
      },
    ],
  };
};

export const mastodonMedia = (
  identity: InstanceIdentity,
  row: {
    id: string;
    object_key: string;
    content_type: string;
  },
): Record<string, unknown> => {
  const url = mediaPublicUrl(identity, row.object_key);
  return {
    id: row.id,
    type: row.content_type.startsWith("video/") ? "video" : "image",
    url,
    preview_url: url,
    remote_url: null,
    text_url: url,
    meta: {},
    description: null,
    blurhash: null,
  };
};

export const unauthorized = () => ({
  error: "This method requires an authenticated user",
});
