import { InstanceIdentity, type LocalAccount, type RemoteActor, Visibility } from "@tstodon/domain";
import {
  accountCounts,
  accountCountsByIds,
  findAccountsByIds,
  type ComposeDefaults,
} from "./account-store";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { type CustomEmoji, customEmojiJson, emojisInText } from "./emoji";
import {
  type AccountProfile,
  EMPTY_ACCOUNT_PROFILE,
  findAccountProfile,
  listAccountProfiles,
} from "./account-profile-store";
import { loadCustomEmojis } from "./custom-emoji-store";
import { textToHtml } from "./html";
import { mediaUrl } from "./media-document";
import { quotePolicyName } from "./quote-policy-name";

/**
 * Account documents keyed by account id, for ids that may be local accounts
 * or remote actors (`r_…`); each side loads in one query, and ids that no
 * longer resolve are left out.
 */
export const accountDocumentsByIds = async (
  env: Env,
  identity: InstanceIdentity,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const documents = new Map<string, Record<string, unknown>>();
  const remote = new Map<string, string>();
  const local: string[] = [];
  for (const id of new Set(ids)) {
    const actorUri = RemoteAccountId.decode(id);
    if (actorUri.isOk()) {
      remote.set(actorUri.value, id);
    } else {
      local.push(id);
    }
  }
  const [locals, actors] = await Promise.all([
    findAccountsByIds(env.DB, local),
    findRemoteActorsByUris(env.DB, [...remote.keys()]),
  ]);
  if (locals.isOk()) {
    for (const [id, document] of await mastodonAccountDocuments(env, identity, [
      ...locals.value.values(),
    ])) {
      documents.set(id, document);
    }
  }
  if (actors.isOk()) {
    for (const [actorUri, id] of remote) {
      const actor = actors.value.get(actorUri);
      if (actor) {
        documents.set(id, mastodonRemoteAccount(identity, actor));
      }
    }
  }
  return documents;
};

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
    indexable: profile.indexable,
    hide_collections: profile.hideCollections,
    // This deployment has no HTML profile surface to point a crawler at.
    noindex: false,
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

/**
 * Mastodon's `source` (CredentialAccount only): the settings behind the
 * rendered account, with the raw bio and fields.
 */
export const accountSource = (
  account: LocalAccount,
  profile: AccountProfile = EMPTY_ACCOUNT_PROFILE,
  defaults: ComposeDefaults = { language: null, sensitive: false },
): Record<string, unknown> => ({
  privacy: Visibility.toMastodon(account.defaultPostVisibility),
  sensitive: defaults.sensitive,
  language: defaults.language,
  note: profile.note,
  fields: profile.fields.map((field) => ({
    name: field.name,
    value: field.value,
    verified_at: null,
  })),
  follow_requests_count: 0,
  quote_policy: quotePolicyName(account.defaultQuotePolicy),
  discoverable: profile.discoverable,
  indexable: profile.indexable,
  hide_collections: profile.hideCollections,
  attribution_domains: [],
});

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

/** {@link mastodonAccountDocument} for many accounts with one counts batch and one profile query. */
export const mastodonAccountDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  accounts: ReadonlyArray<LocalAccount>,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const documents = new Map<string, Record<string, unknown>>();
  if (accounts.length === 0) {
    return documents;
  }
  const accountIds = accounts.map((account) => account.id);
  const [counts, profiles, emojis] = await Promise.all([
    accountCountsByIds(env.DB, accountIds),
    listAccountProfiles(env.DB, accountIds),
    loadCustomEmojis(env, identity.mediaPublicBaseUrl),
  ]);
  for (const account of accounts) {
    documents.set(
      account.id,
      mastodonAccount(
        identity,
        account,
        (counts.isOk() ? counts.value.get(account.id) : undefined) ?? {
          followers: 0,
          following: 0,
          statuses: 0,
        },
        emojisInText(account.displayName, emojis),
        (profiles.isOk() ? profiles.value.get(account.id) : undefined) ?? EMPTY_ACCOUNT_PROFILE,
      ),
    );
  }
  return documents;
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
