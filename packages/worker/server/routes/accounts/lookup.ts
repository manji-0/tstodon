import type { ApiAccountJSON, ApiFamiliarFollowersJSON } from "@tstodon/api";
import {
  ApiGetAccountsParamsSchema,
  ApiGetFamiliarFollowersParamsSchema,
  ApiGetRelationshipsParamsSchema,
  ApiLookupAccountParamsSchema,
  ApiSearchAccountsParamsSchema,
} from "@tstodon/api";
import type { Context } from "hono";
import {
  AccountPresentation,
  type InstanceIdentity,
  type LocalAccount,
  Visibility,
} from "@tstodon/domain";
import { findAccountByIdOrUsername, findAccountsByIds } from "../../account-store";
import { searchAccountsPage } from "../../account-search";
import {
  accountRefPresentation,
  localAccountPresentations,
  presentedAccountDocument,
  remoteAccountPresentations,
  searchableLocalAccounts,
  searchableRemoteActors,
} from "../../account-presentation";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAccountsLimit,
  queryOffset,
  requireUser,
} from "../../http";
import {
  accountDocumentsByIds,
  accountRefDocument,
  documentsInOrder,
  mastodonAccountDocument,
  mastodonAccountDocuments,
  mastodonRemoteAccount,
} from "../../account-documents";
import { mastodonRelationship } from "../../relationship-document";
import { findRemoteActorByUri, findRemoteActorsByUris } from "../../remote-actor-store";
import { resolveRemoteActorByHandle } from "../../remote-actor-fetch";
import { suspendedDomains } from "../../admin-domain-block-store";
import { federationAllowHosts } from "../../runtime-config";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../../d1";
import { RemoteAccountId } from "../../remote-account-id";
import { parseInstanceIdentity } from "../../runtime-config";
import { familiarFollowerIds, followingAccountIds } from "../../follow-store";
import { relationshipFlags } from "../../relationship-store";
import { readQueryParams } from "../../request-params";
import { findKnownAccountHandle, localRef, remoteRef } from "../../account-ref";
import { instanceActorFetchSigner } from "../../instance-actor";

export const getV1AccountsLookup = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/lookup">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  // Without `acct` the lookup finds nothing: 404, as Mastodon.
  const acct = readQueryParams(c, ApiLookupAccountParamsSchema)
    .map((params) => params.acct)
    .unwrapOr("");
  const ref = await findKnownAccountHandle(c.env, identity.value, acct);
  if (ref.isErr()) {
    return ref.error.kind === "RepositoryError"
      ? jsonRepositoryError(c, ref.error.message)
      : c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const document = await accountRefDocument(c.env, identity.value, ref.value);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  return document.value
    ? c.json(document.value)
    : c.json({ error: "Record not found", kind: "NotFound" }, 404);
};

export const getV1AccountsRelationships = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/relationships">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  // `with_suspended` changes nothing: every requested id is answered.
  const params = readQueryParams(c, ApiGetRelationshipsParamsSchema);
  const ids = (params.isOk() ? (params.value.id ?? []) : []).filter((id) => id.length > 0);
  const relationships = [];
  for (const id of ids) {
    const flags = await relationshipFlags(c.env.DB, user.value.id, id);
    if (flags.isOk()) {
      relationships.push(mastodonRelationship(id, flags.value));
    }
  }
  return c.json(relationships);
};

/** Mastodon caps familiar followers per requested account. */
const FAMILIAR_FOLLOWERS_LIMIT = 3;

/**
 * `GET /api/v1/accounts/search`: Mastodon's account-only search. The exact
 * match for a complete `@user@domain` handle is prepended on the first page
 * (resolving it only when `resolve=true`), then local accounts and cached
 * remote actors matching the query follow. `following=true` keeps only
 * accounts the viewer follows; this instance has no record of following remote
 * actors, so remote results are dropped there.
 */
/**
 * `GET /api/v1/preferences`: the posting defaults this instance enforces
 * (`posting:default:visibility` is what an omitted visibility uses) plus
 * Mastodon's reading defaults, which are client-side settings we do not store.
 */
export const getV1Preferences = async (c: Context<{ Bindings: Env }, "/api/v1/preferences">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  return c.json({
    "posting:default:visibility": Visibility.toMastodon(user.value.defaultPostVisibility),
    "posting:default:sensitive": false,
    "posting:default:language": null,
    "reading:expand:media": "default",
    "reading:expand:spoilers": false,
    "reading:autoplay:gifs": false,
  });
};

export const getV1AccountsSearch = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/search">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const params = readQueryParams(c, ApiSearchAccountsParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const rawQuery = (params.value.q ?? "").trim();
  const query = rawQuery.replace(/^@/, "");
  const limit = queryAccountsLimit(params.value.limit);
  const offset = queryOffset(params.value.offset);
  const resolve = params.value.resolve ?? false;
  const onlyFollowing = params.value.following ?? false;
  if (query.length === 0) {
    return c.json([]);
  }
  const followingIds = onlyFollowing
    ? await followingAccountIds(c.env.DB, user.value.id)
    : undefined;
  if (followingIds?.isErr()) {
    return jsonRepositoryError(c, followingIds.error.message);
  }
  const following = followingIds?.isOk() ? followingIds.value : undefined;
  const documents: ApiAccountJSON[] = [];
  const seen = new Set<string>();
  const push = (document: ApiAccountJSON): void => {
    const id = document.id;
    if (!seen.has(id)) {
      seen.add(id);
      documents.push(document);
    }
  };
  const followed = (accountId: string): boolean =>
    following === undefined || following.has(accountId);

  // The exact match, only on the first page and only for a complete handle.
  const handle = /^[^\s@]+@[^\s@]+$/.test(query) ? query : undefined;
  if (offset === 0 && handle) {
    const [username, domain] = handle.split("@");
    if (domain?.toLowerCase() === identity.value.domain.toLowerCase()) {
      const local = await findAccountByIdOrUsername(c.env.DB, username ?? "");
      if (local.isErr()) {
        return jsonRepositoryError(c, local.error.message);
      }
      const shown = await searchableLocalAccounts(c.env.DB, local.value ? [local.value] : []);
      if (shown.isErr()) {
        return jsonRepositoryError(c, shown.error.message);
      }
      for (const account of shown.value.filter((found) => followed(found.id))) {
        push(await mastodonAccountDocument(c.env, identity.value, account));
      }
    } else if (following === undefined) {
      const resolved = resolve
        ? await resolveRemoteActorByHandle(c.env.DB, identity.value, handle, {
            allowHosts: await federationAllowHosts(c.env),
            blockedHosts: await suspendedDomains(c.env.DB),
            fetchSigner: instanceActorFetchSigner(c.env.DB, identity.value),
          })
        : // Without `resolve` only the actor cache is consulted.
          (await findKnownAccountHandle(c.env, identity.value, handle)).andThen((ref) =>
            ref.kind === "RemoteActor" ? ok(ref.actor) : err({ kind: "AccountNotFound" as const }),
          );
      if (resolved.isErr() && resolve && resolved.error.kind === "VerificationUnavailable") {
        // Mastodon's documented 503 for a domain that is not currently live.
        return c.json({ error: "Remote data could not be fetched" }, 503);
      }
      if (resolved.isErr() && resolved.error.kind === "RepositoryError") {
        return jsonRepositoryError(c, resolved.error.message);
      }
      const shown = await searchableRemoteActors(c.env, resolved.isOk() ? [resolved.value] : []);
      if (shown.isErr()) {
        return jsonRepositoryError(c, shown.error.message);
      }
      for (const actor of shown.value) {
        push(mastodonRemoteAccount(identity.value, actor));
      }
    }
  }

  // Non-exact results: local accounts first, then cached remote actors.
  const terms = handle
    ? handle.split("@")[1] === identity.value.domain
      ? (handle.split("@")[0] ?? "")
      : query
    : query;
  // As Mastodon, an exact match counts inside `limit`.
  const page = await searchAccountsPage(
    c.env,
    {
      localTerms: terms,
      remoteTerms: query,
      scope: onlyFollowing
        ? { kind: "FollowedBy", accountId: user.value.id }
        : { kind: "Everyone" },
    },
    limit - documents.length,
    offset,
  );
  if (page.isErr()) {
    return jsonRepositoryError(c, page.error.message);
  }
  const rendered = await mastodonAccountDocuments(c.env, identity.value, page.value.local);
  for (const document of documentsInOrder(
    page.value.local.map((account) => account.id),
    rendered,
  )) {
    push(document);
  }
  for (const actor of page.value.remote) {
    push(mastodonRemoteAccount(identity.value, actor));
  }
  return c.json(documents.slice(0, limit));
};

export const getV1AccountsFamiliarFollowers = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/familiar_followers">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const params = readQueryParams(c, ApiGetFamiliarFollowersParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const requestedIds = (params.value.id ?? []).filter((value) => value.length > 0);

  const groups: ApiFamiliarFollowersJSON = [];
  for (const requestedId of requestedIds) {
    const account = await findAccountByIdOrUsername(c.env.DB, requestedId);
    if (account.isErr()) {
      return jsonRepositoryError(c, account.error.message);
    }
    const accounts = account.value
      ? await familiarFollowerDocuments(c.env, identity.value, user.value.id, account.value)
      : ok([]);
    if (accounts.isErr()) {
      return jsonRepositoryError(c, accounts.error.message);
    }
    groups.push({ id: requestedId, accounts: accounts.value });
  }
  return c.json(groups);
};

/** The viewer's follows that follow `account`; none when `account` is not available. */
const familiarFollowerDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  viewerId: string,
  account: LocalAccount,
): Promise<Result<ApiAccountJSON[], RepositoryError>> => {
  const presentation = await accountRefPresentation(env, localRef(identity, account));
  if (presentation.isErr()) {
    return err(presentation.error);
  }
  if (!AccountPresentation.available(presentation.value)) {
    return ok([]);
  }
  const followerIds = await familiarFollowerIds(
    env.DB,
    viewerId,
    account.id,
    FAMILIAR_FOLLOWERS_LIMIT,
  );
  if (followerIds.isErr()) {
    return err(followerIds.error);
  }
  return (await accountDocumentsByIds(env, identity, followerIds.value)).map((documents) =>
    documentsInOrder(followerIds.value, documents),
  );
};

/**
 * A local account id/username or a `r_` remote account id's document;
 * `undefined` when no account a read path may show has that id.
 */
export const lookupAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  id: string,
): Promise<Result<ApiAccountJSON | undefined, RepositoryError>> => {
  const account = await findAccountByIdOrUsername(env.DB, id);
  if (account.isErr()) {
    return err(account.error);
  }
  if (account.value) {
    return accountRefDocument(env, identity, localRef(identity, account.value));
  }
  const actorUri = RemoteAccountId.decode(id);
  if (actorUri.isErr()) {
    return ok(undefined);
  }
  const actor = await findRemoteActorByUri(env.DB, actorUri.value);
  if (actor.isErr()) {
    return err(actor.error);
  }
  return actor.value ? accountRefDocument(env, identity, remoteRef(actor.value)) : ok(undefined);
};

/** Mastodon caps `GET /api/v1/accounts?id[]=` at 40 ids. */
const MULTIPLE_ACCOUNTS_LIMIT = 40;

export const getV1Accounts = async (c: Context<{ Bindings: Env }, "/api/v1/accounts">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const params = readQueryParams(c, ApiGetAccountsParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const ids = [...new Set((params.value.id ?? []).filter((id) => id.length > 0))].slice(
    0,
    MULTIPLE_ACCOUNTS_LIMIT,
  );
  // Each lookup is one query for the whole batch; unknown and hidden accounts
  // are left out rather than failing it.
  const remoteUris = new Map(
    ids.flatMap((id): [string, string][] => {
      const actorUri = RemoteAccountId.decode(id);
      return actorUri.isOk() ? [[id, actorUri.value]] : [];
    }),
  );
  const [locals, localPresentations, remotes] = await Promise.all([
    findAccountsByIds(c.env.DB, ids),
    localAccountPresentations(c.env.DB, ids),
    findRemoteActorsByUris(c.env.DB, [...remoteUris.values()]),
  ]);
  if (locals.isErr()) {
    return jsonRepositoryError(c, locals.error.message);
  }
  if (localPresentations.isErr()) {
    return jsonRepositoryError(c, localPresentations.error.message);
  }
  if (remotes.isErr()) {
    return jsonRepositoryError(c, remotes.error.message);
  }
  const remotePresentations = await remoteAccountPresentations(c.env, [...remotes.value.values()]);
  if (remotePresentations.isErr()) {
    return jsonRepositoryError(c, remotePresentations.error.message);
  }
  const localDocuments = await mastodonAccountDocuments(c.env, identity.value, [
    ...locals.value.values(),
  ]);
  return c.json(
    ids.flatMap((id) => {
      const local = localDocuments.get(id);
      const localPresentation = localPresentations.value.get(id);
      if (local && localPresentation) {
        const document = presentedAccountDocument(identity.value, localPresentation, local);
        return document ? [document] : [];
      }
      const actorUri = remoteUris.get(id);
      const actor = actorUri === undefined ? undefined : remotes.value.get(actorUri);
      const remotePresentation =
        actorUri === undefined ? undefined : remotePresentations.value.get(actorUri);
      if (!actor || !remotePresentation) {
        return [];
      }
      const document = presentedAccountDocument(
        identity.value,
        remotePresentation,
        mastodonRemoteAccount(identity.value, actor),
      );
      return document ? [document] : [];
    }),
  );
};
