import { warmSchemas } from "@tstodon/core";
import type { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountById, findAccountByUsername } from "../account-store";
import { errorPage } from "../auth-pages";
import { browserSession } from "../browser-session";
import type { RepositoryError } from "../d1";
import { pageRedirect, signInRedirect } from "../page-redirect";
import { resolveRemoteActorByHandle } from "../remote-actor-fetch";
import { findRemoteActorByUri } from "../remote-actor-store";
import { readQueryParams } from "../request-params";
import { parseInstanceIdentity } from "../runtime-config";
import {
  localHandleUsername,
  resolveFetchOptions,
  resolveSearchUrl,
  type UrlResource,
} from "../search-url";
import { instanceName } from "./account-settings";

/**
 * Mastodon's `AuthorizeInteractionsController`: the page another server's
 * "interact from your server" sends a user to, through this server's
 * WebFinger `subscribe` and FEP-3b86 `Object` templates. It resolves the
 * account or status `uri` names and opens it in the web app.
 */

const QuerySchema = z.object({ uri: z.string().optional(), acct: z.string().optional() });

const remoteAcct = (actor: RemoteActor): string => `${actor.username}@${actor.domain}`;

/** The web app's path for what a URL names (Mastodon's `web_url("@acct")` / `web_url("@acct/id")`). */
const webPath = async (
  db: D1Database,
  resource: UrlResource,
): Promise<Result<string | undefined, RepositoryError>> => {
  switch (resource.kind) {
    case "LocalAccount":
      return ok(`/@${resource.account.username}`);
    case "RemoteAccount":
      return ok(`/@${remoteAcct(resource.actor)}`);
    case "Status": {
      const found = resource.status;
      if (found.kind === "LocalStatus") {
        const author = await findAccountById(db, found.status.accountId);
        return author.map((account) => account && `/@${account.username}/${found.status.id}`);
      }
      const author = await findRemoteActorByUri(db, found.status.actorUri);
      return author.map((actor) => actor && `/@${remoteAcct(actor)}/${found.status.id}`);
    }
  }
};

/**
 * The account a handle names, as Mastodon's `ResolveAccountService`: a bare
 * username or one on this server's domain is local, any other is looked up
 * over WebFinger.
 */
const handlePath = async (
  env: Env,
  identity: InstanceIdentity,
  handle: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  const bare = handle.trim().replace(/^@/, "");
  const local = bare.includes("@") ? localHandleUsername(identity, bare) : bare;
  if (local !== undefined) {
    const account = await findAccountByUsername(env.DB, local);
    return account.map((found) => found && `/@${found.username}`);
  }
  const actor = await resolveRemoteActorByHandle(
    env.DB,
    identity,
    bare,
    await resolveFetchOptions(env, identity),
  );
  if (actor.isOk()) {
    return ok(`/@${remoteAcct(actor.value)}`);
  }
  return actor.error.kind === "RepositoryError" ? err(actor.error) : ok(undefined);
};

const interactionPath = async (
  env: Env,
  identity: InstanceIdentity,
  uri: string,
  viewerId: string,
): Promise<Result<string | undefined, RepositoryError>> => {
  if (!/^https?:\/\//i.test(uri)) {
    return handlePath(env, identity, uri);
  }
  const resource = await resolveSearchUrl(
    env,
    identity,
    uri,
    viewerId,
    await resolveFetchOptions(env, identity),
  );
  if (resource.isErr()) {
    return err(resource.error);
  }
  return resource.value ? webPath(env.DB, resource.value) : ok(undefined);
};

/** Mastodon's `not_found` page. */
const notFound = (c: Context<{ Bindings: Env }>) =>
  c.html(errorPage(instanceName(c.env), "The page you are looking for isn't here."), 404);

/** `GET /authorize_interaction?uri=…` (or `?acct=…`, as the old remote-follow form sent). */
export const getAuthorizeInteraction = async (
  c: Context<{ Bindings: Env }, "/authorize_interaction">,
) => {
  const session = await browserSession(c.req.raw, c.env);
  switch (session.kind) {
    case "SignedOut":
      return signInRedirect(c);
    case "NoAccount":
    case "Barred":
      return c.html(
        errorPage(instanceName(c.env), "This sign-in has no account that can interact."),
        403,
      );
    case "Account":
      break;
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  const query = readQueryParams(c, QuerySchema);
  if (query.isErr()) {
    return notFound(c);
  }
  const uri = query.value.uri ?? (query.value.acct ?? "").replace(/^acct:/, "");
  const path = await interactionPath(c.env, identity.value, uri, session.account.id);
  if (path.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not look that up."), 500);
  }
  return path.value === undefined ? notFound(c) : pageRedirect(c, path.value);
};

/**
 * Mastodon's `/authorize_follow` and `/.well-known/proxy`, the older names of
 * `/authorize_interaction`: a permanent redirect with the same query.
 */
export const redirectToAuthorizeInteraction = (c: Context<{ Bindings: Env }>) =>
  pageRedirect(c, `/authorize_interaction${new URL(c.req.url).search}`, 301);

/**
 * Mastodon's `IntentsController`: a `web+mastodon://follow?uri=…` link opens
 * `/authorize_interaction`, a `web+mastodon://share?text=…` link `/share`.
 */
export const getIntent = (c: Context<{ Bindings: Env }, "/intent">) => {
  const intent = URL.parse(c.req.query("uri") ?? "");
  if (intent?.protocol !== "web+mastodon:") {
    return notFound(c);
  }
  switch (intent.host) {
    case "follow": {
      const uri = (intent.searchParams.get("uri") ?? "").replace(/^acct:/, "");
      return pageRedirect(c, `/authorize_interaction?${new URLSearchParams({ uri }).toString()}`);
    }
    case "share": {
      const text = intent.searchParams.get("text") ?? "";
      return pageRedirect(c, `/share?${new URLSearchParams({ text }).toString()}`);
    }
    default:
      return notFound(c);
  }
};

warmSchemas([QuerySchema]);
