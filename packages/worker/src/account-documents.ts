import {
  type AccountPresentation,
  InstanceIdentity,
  type LocalAccount,
  type RemoteActor,
  Visibility,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { accountCounts, accountCountsByIds } from "./account-count-store";
import {
  localAccountPresentations,
  presentedAccountDocument,
  remoteAccountPresentations,
} from "./account-presentation";
import { type AccountRef, refAccountId } from "./account-ref";
import type { RepositoryError } from "./d1";
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
  const localDocuments = locals.isOk()
    ? await mastodonAccountDocuments(env, identity, [...locals.value.values()])
    : new Map<string, Record<string, unknown>>();
  if (actors.isErr()) {
    return localDocuments;
  }
  const moved = await movedToDocuments(
    env,
    identity,
    [...actors.value.values()].flatMap((actor) => (actor.movedTo ? [actor.movedTo] : [])),
  );
  const remoteDocuments = [...remote].flatMap(
    ([actorUri, id]): [string, Record<string, unknown>][] => {
      const actor = actors.value.get(actorUri);
      if (!actor) {
        return [];
      }
      const target = actor.movedTo ? moved.get(actor.movedTo) : undefined;
      return [
        [id, { ...(target ? { moved: target } : {}), ...mastodonRemoteAccount(identity, actor) }],
      ];
    },
  );
  return new Map([...localDocuments, ...remoteDocuments]);
};

/** `documents`, keyed by local account id, with `moved` for the accounts that moved away. */
const withLocalMoves = async (
  env: Env,
  identity: InstanceIdentity,
  documents: ReadonlyMap<string, Record<string, unknown>>,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const targets = await listAccountMoveTargets(env.DB, [...documents.keys()]);
  if (targets.isErr() || targets.value.size === 0) {
    return documents;
  }
  const moved = await movedToDocuments(env, identity, [...targets.value.values()]);
  const movedTo = (id: string) => {
    const targetUri = targets.value.get(id);
    return targetUri === undefined ? undefined : moved.get(targetUri);
  };
  return new Map(
    [...documents].map(([id, document]) => {
      const target = movedTo(id);
      return [id, target ? { moved: target, ...document } : document];
    }),
  );
};

/**
 * The accounts that moved accounts point at, keyed by actor URI, as Mastodon
 * renders them under `moved`: a local account or a cached remote actor,
 * through the same presentation rule as the account read paths, so a
 * suspended target is stripped and a hidden one is left out. One level deep;
 * a target's own `moved` is left out.
 */
const movedToDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  actorUris: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  if (actorUris.length === 0) {
    return new Map();
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
  const localAccounts = locals.isOk() ? locals.value : [];
  const remoteActors = actors.isOk() ? [...actors.value.values()] : [];
  const [localDocuments, localPresentations, remotePresentations] = await Promise.all([
    mastodonAccountDocuments(env, identity, localAccounts, false),
    localAccountPresentations(
      env.DB,
      localAccounts.map((account) => account.id),
    ),
    remoteAccountPresentations(env, remoteActors),
  ]);
  const presented = (
    uri: string,
    presentation: AccountPresentation | undefined,
    document: Record<string, unknown> | undefined,
  ): [string, Record<string, unknown>][] => {
    const shown =
      presentation && document && presentedAccountDocument(identity, presentation, document);
    return shown ? [[uri, shown]] : [];
  };
  return new Map([
    ...localAccounts.flatMap((account) =>
      presented(
        InstanceIdentity.actorUrl(identity, account.username),
        localPresentations.isOk() ? localPresentations.value.get(account.id) : undefined,
        localDocuments.get(account.id),
      ),
    ),
    ...remoteActors.flatMap((actor) =>
      presented(
        actor.actorUri,
        remotePresentations.isOk() ? remotePresentations.value.get(actor.actorUri) : undefined,
        mastodonRemoteAccount(identity, actor),
      ),
    ),
  ]);
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
  if (accounts.length === 0) {
    return new Map();
  }
  const accountIds = accounts.map((account) => account.id);
  const [counts, profiles, emojis] = await Promise.all([
    accountCountsByIds(env.DB, accountIds),
    listAccountProfiles(env.DB, accountIds),
    loadCustomEmojis(env, identity.mediaPublicBaseUrl),
  ]);
  const documents = new Map(
    accounts.map((account) => [
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
    ]),
  );
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

/** One account's document as lookup and `GET /accounts/:id` answer it; `undefined` when hidden. */
export const accountRefDocument = async (
  env: Env,
  identity: InstanceIdentity,
  ref: AccountRef,
): Promise<Result<Record<string, unknown> | undefined, RepositoryError>> => {
  const id = refAccountId(ref);
  const presentations =
    ref.kind === "LocalAccount"
      ? await localAccountPresentations(env.DB, [id])
      : await remoteAccountPresentations(env, [ref.actor]);
  if (presentations.isErr()) {
    return err(presentations.error);
  }
  const presentation = presentations.value.get(
    ref.kind === "LocalAccount" ? id : ref.actor.actorUri,
  );
  if (presentation === undefined || presentation.kind === "Hidden") {
    return ok(undefined);
  }
  const document =
    ref.kind === "LocalAccount"
      ? await mastodonAccountDocument(env, identity, ref.account)
      : (await accountDocumentsByIds(env, identity, [id])).get(id);
  return ok(document && presentedAccountDocument(identity, presentation, document));
};
