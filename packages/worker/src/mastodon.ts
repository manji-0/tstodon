import {
  InstanceIdentity,
  Visibility,
  type LocalAccount,
  type LocalStatus,
  type RemoteActor,
  type RemoteStatus as RemoteStatusValue,
} from "@tstodon/domain";
import { accountCounts, findAccountById } from "./account-store";
import { findPollByStatusId, type PollRecord } from "./poll-store";
import { findStatusById } from "./status-store";
import { statusInteractionCounts, type NotificationRow } from "./social-store";
import { findMediaById } from "./media-store";
import { FilterContextSchema, parseJsonColumn } from "./schemas";
import type { FilterRow } from "./moderation-store";

const mediaUrl = (identity: InstanceIdentity, objectKey: string): string =>
  `${identity.mediaPublicBaseUrl.replace(/\/$/, "")}/${objectKey}`;

export const mastodonAccount = (
  identity: InstanceIdentity,
  account: LocalAccount,
  counts: { followers: number; following: number; statuses: number },
): Record<string, unknown> => {
  const url = InstanceIdentity.actorUrl(identity, account.username);
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
    avatar: identity.thumbnailUrl,
    avatar_static: identity.thumbnailUrl,
    header: identity.thumbnailUrl,
    header_static: identity.thumbnailUrl,
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

export const mastodonStatus = async (
  env: Env,
  identity: InstanceIdentity,
  status: LocalStatus,
  viewerId: string | undefined,
): Promise<Record<string, unknown> | undefined> => {
  const accountResult = await findAccountById(env.DB, status.accountId);
  if (accountResult.isErr() || !accountResult.value) {
    return undefined;
  }
  const account = await mastodonAccountDocument(env, identity, accountResult.value);
  if (status.kind === "LocalReblog") {
    const target = await findStatusById(env.DB, status.reblogOfId);
    if (target.isErr() || !target.value) {
      return undefined;
    }
    const wrapped = await mastodonStatus(env, identity, target.value, viewerId);
    if (!wrapped) {
      return undefined;
    }
    return {
      ...wrapped,
      id: status.id,
      reblog: wrapped,
      account,
      created_at: status.createdAt,
    };
  }
  const counts = await statusInteractionCounts(env.DB, status.id, viewerId);
  const interactions = counts.isOk()
    ? counts.value
    : {
        favourites: 0,
        reblogs: 0,
        favourited: false,
        reblogged: false,
        bookmarked: false,
      };
  const poll = await findPollByStatusId(env.DB, status.id, viewerId);
  const media = [];
  for (const mediaId of status.mediaIds) {
    const row = await findMediaById(env.DB, mediaId);
    if (row.isOk() && row.value) {
      const url = mediaUrl(identity, row.value.object_key);
      media.push({
        id: row.value.id,
        type: row.value.content_type.startsWith("video/") ? "video" : "image",
        url,
        preview_url: url,
        remote_url: null,
        text_url: url,
        meta: {},
        description: null,
        blurhash: null,
      });
    }
  }
  let inReplyToId: string | null = null;
  let inReplyToAccountId: string | null = null;
  if (status.inReplyToId) {
    inReplyToId = status.inReplyToId;
    const parent = await findStatusById(env.DB, status.inReplyToId);
    if (parent.isOk() && parent.value) {
      inReplyToAccountId = parent.value.accountId;
    }
  }
  const url = `${InstanceIdentity.actorUrl(identity, accountResult.value.username)}/statuses/${status.id}`;
  return {
    id: status.id,
    created_at: status.createdAt,
    in_reply_to_id: inReplyToId,
    in_reply_to_account_id: inReplyToAccountId,
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
    account,
    media_attachments: media,
    mentions: [],
    tags: [],
    emojis: [],
    card: null,
    poll: poll.isOk() && poll.value ? pollJson(poll.value) : null,
  };
};

export const mastodonStatuses = async (
  env: Env,
  identity: InstanceIdentity,
  statuses: ReadonlyArray<LocalStatus>,
  viewerId: string | undefined,
): Promise<Record<string, unknown>[]> => {
  const documents: Record<string, unknown>[] = [];
  for (const status of statuses) {
    const document = await mastodonStatus(env, identity, status, viewerId);
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
  const url = mediaUrl(identity, row.object_key);
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
