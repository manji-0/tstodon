import { InstanceIdentity, type LocalAccount, type RemoteActor, Visibility } from "@tstodon/domain";
import { accountCounts, accountCountsByIds } from "./account-count-store";
import { listAccountMoveTargets } from "./account-move-store";
import { findAccountsByIds, findAccountsByUsernames } from "./account-store";
import { parseLocalActorUsername } from "./activitypub";
import type { ComposeDefaults } from "./account-defaults-store";
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
    const moved = await movedToDocuments(
      env,
      identity,
      [...actors.value.values()].flatMap((actor) => (actor.movedTo ? [actor.movedTo] : [])),
    );
    for (const [actorUri, id] of remote) {
      const actor = actors.value.get(actorUri);
      if (actor) {
        const target = actor.movedTo ? moved.get(actor.movedTo) : undefined;
        documents.set(id, {
          ...(target ? { moved: target } : {}),
          ...mastodonRemoteAccount(identity, actor),
        });
      }
    }
  }
  return documents;
};

/** `documents`, keyed by local account id, with `moved` for the accounts that moved away. */
const withLocalMoves = async (
  env: Env,
  identity: InstanceIdentity,
  documents: Map<string, Record<string, unknown>>,
): Promise<Map<string, Record<string, unknown>>> => {
  const targets = await listAccountMoveTargets(env.DB, [...documents.keys()]);
  if (targets.isErr() || targets.value.size === 0) {
    return documents;
  }
  const moved = await movedToDocuments(env, identity, [...targets.value.values()]);
  for (const [id, targetUri] of targets.value) {
    const document = documents.get(id);
    const target = moved.get(targetUri);
    if (document && target) {
      documents.set(id, { moved: target, ...document });
    }
  }
  return documents;
};

/**
 * The accounts that moved accounts point at, keyed by actor URI, as Mastodon
 * renders them under `moved`: a local account or a cached remote actor. One
 * level deep; a target's own `moved` is left out.
 */
const movedToDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  actorUris: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const documents = new Map<string, Record<string, unknown>>();
  if (actorUris.length === 0) {
    return documents;
  }
  const usernames = actorUris.flatMap((uri) => {
    const username = parseLocalActorUsername(identity, uri);
    return username === undefined ? [] : [username];
  });
  const [locals, actors] = await Promise.all([
    findAccountsByUsernames(env.DB, usernames),
    findRemoteActorsByUris(
      env.DB,
      actorUris.filter((uri) => parseLocalActorUsername(identity, uri) === undefined),
    ),
  ]);
  if (locals.isOk()) {
    const targets = await mastodonAccountDocuments(env, identity, locals.value, false);
    for (const document of targets.values()) {
      if (typeof document.uri === "string") {
        documents.set(document.uri, document);
      }
    }
  }
  if (actors.isOk()) {
    for (const [uri, actor] of actors.value) {
      documents.set(uri, mastodonRemoteAccount(identity, actor));
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
    // Mastodon 4.6+ fields: alt text for the images, profile tab visibility,
    // and featuring policy (featuring accounts is not offered here).
    avatar_description: "",
    header_description: "",
    show_media: true,
    show_media_replies: true,
    show_featured: true,
    feature_approval: { automatic: [], manual: [], current_user: "denied" },
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

/** The documents for `ids` in that order, skipping ids that did not resolve. */
export const documentsInOrder = (
  ids: ReadonlyArray<string>,
  documents: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, unknown>[] =>
  ids.flatMap((id) => {
    const document = documents.get(id);
    return document ? [document] : [];
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
  const document = mastodonAccount(
    identity,
    account,
    counts.isOk() ? counts.value : { followers: 0, following: 0, statuses: 0 },
    emojisInText(account.displayName, await loadCustomEmojis(env, identity.mediaPublicBaseUrl)),
    profile.isOk() ? profile.value : EMPTY_ACCOUNT_PROFILE,
  );
  return (
    (await withLocalMoves(env, identity, new Map([[account.id, document]]))).get(account.id) ??
    document
  );
};

/**
 * {@link mastodonAccountDocument} for many accounts with one counts batch and
 * one profile query. `includeMoved: false` leaves out `moved`, for documents
 * rendered under another account's `moved`.
 */
export const mastodonAccountDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  accounts: ReadonlyArray<LocalAccount>,
  includeMoved = true,
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
  return includeMoved ? withLocalMoves(env, identity, documents) : documents;
};

/** A remote actor as a Mastodon account (`moved` is added by {@link accountDocumentsByIds}). */
export const mastodonRemoteAccount = (
  identity: InstanceIdentity,
  actor: RemoteActor,
): Record<string, unknown> => {
  const { profile } = actor;
  return {
    id: RemoteAccountId.encode(actor.actorUri),
    username: actor.username,
    acct: `${actor.username}@${actor.domain}`,
    display_name: actor.displayName,
    locked: profile.locked,
    bot: profile.bot,
    discoverable: true,
    indexable: false,
    hide_collections: false,
    noindex: false,
    group: false,
    created_at: profile.publishedAt ?? actor.fetchedAt,
    note: profile.note.length > 0 ? textToHtml(profile.note) : "",
    url: profile.profileUrl ?? actor.actorUri,
    uri: actor.actorUri,
    avatar: profile.avatarUrl ?? identity.thumbnailUrl,
    avatar_static: profile.avatarUrl ?? identity.thumbnailUrl,
    header: profile.headerUrl ?? identity.thumbnailUrl,
    header_static: profile.headerUrl ?? identity.thumbnailUrl,
    // Mastodon 4.6+ fields: alt text for the images, profile tab visibility,
    // and featuring policy (featuring accounts is not offered here).
    avatar_description: "",
    header_description: "",
    show_media: true,
    show_media_replies: true,
    show_featured: true,
    feature_approval: { automatic: [], manual: [], current_user: "denied" },
    followers_count: 0,
    following_count: 0,
    statuses_count: 0,
    last_status_at: null,
    emojis: [],
    fields: [],
  };
};
