import type { Context } from "hono";
import { type InstanceIdentity, Visibility } from "@tstodon/domain";
import {
  findAccountById,
  findAccountByIdOrUsername,
  findAccountByUsername,
  findAccountsByIds,
  searchAccounts,
} from "../../account-store";
import { getAccountModeration, listAccountModerations } from "../../account-moderation-store";
import { jsonAuthError, jsonRepositoryError, queryAccountsLimit, requireUser } from "../../http";
import {
  mastodonAccountDocument,
  mastodonAccountDocuments,
  mastodonRemoteAccount,
} from "../../account-documents";
import { mastodonRelationship } from "../../relationship-document";
import {
  findRemoteActorByUri,
  findRemoteActorsByUris,
  searchRemoteActors,
} from "../../remote-actor-store";
import { resolveRemoteActorByHandle } from "../../remote-actor-fetch";
import { suspendedDomains } from "../../admin-domain-block-store";
import { federationAllowHosts } from "../../runtime-config";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "../../d1";
import { RemoteAccountId } from "../../remote-account-id";
import { parseInstanceIdentity } from "../../runtime-config";
import { familiarFollowerIds, followingAccountIds } from "../../follow-store";
import { relationshipFlags } from "../../relationship-store";
import { isTruthy } from "../../form-values";

export const getV1AccountsLookup = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/lookup">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const acct = (c.req.query("acct") ?? "").split("@")[0] ?? "";
  const account = await findAccountByUsername(c.env.DB, acct);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await mastodonAccountDocument(c.env, identity.value, account.value));
};

export const getV1AccountsRelationships = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/relationships">,
) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const url = new URL(c.req.url);
  const ids = [...url.searchParams.getAll("id[]"), ...url.searchParams.getAll("id")].filter(
    (id) => id.length > 0,
  );
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
  const rawQuery = (c.req.query("q") ?? "").trim();
  const query = rawQuery.replace(/^@/, "");
  const limit = queryAccountsLimit(c.req.query("limit"));
  const requestedOffset = Number.parseInt(c.req.query("offset") ?? "0", 10);
  const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;
  const resolve = isTruthy(c.req.query("resolve"));
  const onlyFollowing = isTruthy(c.req.query("following"));
  if (query.length === 0) {
    return c.json([]);
  }
  const following = onlyFollowing ? await followingAccountIds(c.env.DB, user.value.id) : undefined;
  if (following?.isErr()) {
    return jsonRepositoryError(c, following.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (document: Record<string, unknown>): void => {
    const id = String(document.id);
    if (!seen.has(id)) {
      seen.add(id);
      documents.push(document);
    }
  };
  const followed = (accountId: string): boolean =>
    following === undefined || (following.isOk() && following.value.has(accountId));

  // The exact match, only on the first page and only for a complete handle.
  const handle = /^[^\s@]+@[^\s@]+$/.test(query) ? query : undefined;
  if (offset === 0 && handle) {
    const [username, domain] = handle.split("@");
    if (domain?.toLowerCase() === identity.value.domain.toLowerCase()) {
      const local = await findAccountByIdOrUsername(c.env.DB, username ?? "");
      if (local.isErr()) {
        return jsonRepositoryError(c, local.error.message);
      }
      if (local.value && followed(local.value.id)) {
        push(await mastodonAccountDocument(c.env, identity.value, local.value));
      }
    } else if (following === undefined) {
      const resolved = resolve
        ? await resolveRemoteActorByHandle(c.env.DB, identity.value, handle, {
            allowHosts: await federationAllowHosts(c.env),
            blockedHosts: await suspendedDomains(c.env.DB),
          })
        : await (async () => {
            // Without `resolve` only the actor cache is consulted.
            const cached = await searchRemoteActors(c.env.DB, handle, 1);
            const exact = cached.isOk()
              ? cached.value.find(
                  (actor) =>
                    `${actor.username}@${actor.domain}`.toLowerCase() === handle.toLowerCase(),
                )
              : undefined;
            return exact ? ok(exact) : err({ kind: "InvalidSignature" as const });
          })();
      if (resolved.isErr() && resolve && resolved.error.kind === "VerificationUnavailable") {
        // Mastodon's documented 503 for a domain that is not currently live.
        return c.json({ error: "Remote data could not be fetched" }, 503);
      }
      if (resolved.isOk()) {
        push(mastodonRemoteAccount(identity.value, resolved.value));
      }
    }
  }

  // Non-exact results: local accounts first, then cached remote actors.
  const remaining = Math.max(limit - documents.length, 0);
  const terms = handle
    ? handle.split("@")[1] === identity.value.domain
      ? (handle.split("@")[0] ?? "")
      : query
    : query;
  if (remaining > 0) {
    const local = await searchAccounts(c.env.DB, terms, remaining + offset, offset);
    if (local.isErr()) {
      return jsonRepositoryError(c, local.error.message);
    }
    for (const account of local.value) {
      if (!followed(account.id)) {
        continue;
      }
      push(await mastodonAccountDocument(c.env, identity.value, account));
      if (documents.length >= limit) {
        break;
      }
    }
  }
  if (following === undefined && documents.length < limit) {
    const remote = await searchRemoteActors(c.env.DB, query, limit + offset);
    if (remote.isErr()) {
      return jsonRepositoryError(c, remote.error.message);
    }
    for (const actor of remote.value) {
      if (documents.length >= limit) {
        break;
      }
      push(mastodonRemoteAccount(identity.value, actor));
    }
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
  const url = new URL(c.req.url);
  const requestedIds = [
    ...url.searchParams.getAll("id[]"),
    ...url.searchParams.getAll("id"),
  ].filter((value) => value.length > 0);

  const groups: Record<string, unknown>[] = [];
  for (const requestedId of requestedIds) {
    const account = await findAccountByIdOrUsername(c.env.DB, requestedId);
    if (account.isErr()) {
      return jsonRepositoryError(c, account.error.message);
    }
    const accounts: Record<string, unknown>[] = [];
    if (account.value) {
      const followerIds = await familiarFollowerIds(
        c.env.DB,
        user.value.id,
        account.value.id,
        FAMILIAR_FOLLOWERS_LIMIT,
      );
      if (followerIds.isErr()) {
        return jsonRepositoryError(c, followerIds.error.message);
      }
      for (const followerId of followerIds.value) {
        const follower = await findAccountById(c.env.DB, followerId);
        if (follower.isOk() && follower.value) {
          accounts.push(await mastodonAccountDocument(c.env, identity.value, follower.value));
        }
      }
    }
    groups.push({ id: requestedId, accounts });
  }
  return c.json(groups);
};

type AccountLookup =
  | Readonly<{ kind: "Found"; document: Record<string, unknown> }>
  | Readonly<{ kind: "Suspended" }>
  | Readonly<{ kind: "NotFound" }>;

/** Resolves a local account id/username or a `r_` remote account id to its document. */
export const lookupAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  id: string,
): Promise<Result<AccountLookup, RepositoryError>> => {
  const account = await findAccountByIdOrUsername(env.DB, id);
  if (account.isErr()) {
    return err(account.error);
  }
  if (account.value) {
    const moderation = await getAccountModeration(env.DB, account.value.id);
    if (moderation.isOk() && moderation.value === "Suspended") {
      return ok({ kind: "Suspended" });
    }
    return ok({
      kind: "Found",
      document: await mastodonAccountDocument(env, identity, account.value),
    });
  }
  const actorUri = RemoteAccountId.decode(id);
  if (actorUri.isOk()) {
    const actor = await findRemoteActorByUri(env.DB, actorUri.value);
    if (actor.isErr()) {
      return err(actor.error);
    }
    if (actor.value) {
      return ok({ kind: "Found", document: mastodonRemoteAccount(identity, actor.value) });
    }
  }
  return ok({ kind: "NotFound" });
};

/** Mastodon caps `GET /api/v1/accounts?id[]=` at 40 ids. */
const MULTIPLE_ACCOUNTS_LIMIT = 40;

export const getV1Accounts = async (c: Context<{ Bindings: Env }, "/api/v1/accounts">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const url = new URL(c.req.url);
  const ids = [
    ...new Set(
      [...url.searchParams.getAll("id[]"), ...url.searchParams.getAll("id")].filter(
        (id) => id.length > 0,
      ),
    ),
  ].slice(0, MULTIPLE_ACCOUNTS_LIMIT);
  // Each lookup is one query for the whole batch; unknown and suspended
  // accounts are left out rather than failing it.
  const remoteUris = new Map<string, string>();
  for (const id of ids) {
    const actorUri = RemoteAccountId.decode(id);
    if (actorUri.isOk()) {
      remoteUris.set(id, actorUri.value);
    }
  }
  const [locals, moderations, remotes] = await Promise.all([
    findAccountsByIds(c.env.DB, ids),
    listAccountModerations(c.env.DB, ids),
    findRemoteActorsByUris(c.env.DB, [...remoteUris.values()]),
  ]);
  if (locals.isErr()) {
    return jsonRepositoryError(c, locals.error.message);
  }
  if (moderations.isErr()) {
    return jsonRepositoryError(c, moderations.error.message);
  }
  if (remotes.isErr()) {
    return jsonRepositoryError(c, remotes.error.message);
  }
  const visibleLocals = [...locals.value.values()].filter(
    (account) => moderations.value.get(account.id) !== "Suspended",
  );
  const localDocuments = await mastodonAccountDocuments(c.env, identity.value, visibleLocals);
  return c.json(
    ids.flatMap((id) => {
      const local = localDocuments.get(id);
      if (local) {
        return [local];
      }
      const actorUri = remoteUris.get(id);
      const actor = actorUri === undefined ? undefined : remotes.value.get(actorUri);
      return actor ? [mastodonRemoteAccount(identity.value, actor)] : [];
    }),
  );
};
