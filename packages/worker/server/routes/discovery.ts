import type { NodeInfoDiscoveryJSON, WebFingerJrdJSON } from "@tstodon/api/activitypub";
import type { InstanceIdentity, LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { findAccountStanding } from "../account-moderation-store";
import { findAccountProfile } from "../account-profile-store";
import { findAccountByUsername, isDeletedAccountName } from "../account-store";
import type { RepositoryError } from "../d1";
import { jsonRepositoryError } from "../http";
import { mediaPublicUrl } from "../media-keys";
import { pageRedirect } from "../page-redirect";
import { isLimitedFederation, parseInstanceIdentity } from "../runtime-config";
import {
  accountJrd,
  instanceActorJrd,
  type WebFingerAvatar,
  webFingerResource,
} from "../webfinger-resource";

/**
 * Mastodon's `show_avatar?`: an avatar with a media type, unless the server
 * hides profiles from strangers (limited federation). A suspended account
 * shows none, as its actor document.
 */
const webFingerAvatar = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Result<WebFingerAvatar | undefined, RepositoryError>> => {
  const [profile, standing, limited] = await Promise.all([
    findAccountProfile(env.DB, account.id),
    findAccountStanding(env.DB, account.id),
    isLimitedFederation(env),
  ]);
  if (profile.isErr()) {
    return err(profile.error);
  }
  if (standing.isErr()) {
    return err(standing.error);
  }
  const { avatarObjectKey, avatarContentType } = profile.value;
  return ok(
    avatarObjectKey === null ||
      avatarContentType === null ||
      limited ||
      standing.value.kind === "Suspended"
      ? undefined
      : { href: mediaPublicUrl(identity, avatarObjectKey), type: avatarContentType },
  );
};

/** Mastodon's `head 400` / `head 404` / `head 410`, cached for 3 minutes. */
const webFingerRefusal = (status: 400 | 404 | 410): Response =>
  new Response(null, { status, headers: { "Cache-Control": "max-age=180, public" } });

const webFingerAnswer = (document: WebFingerJrdJSON): Response =>
  new Response(JSON.stringify(document), {
    headers: {
      "Content-Type": "application/jrd+json; charset=utf-8",
      "Cache-Control": "max-age=259200, public",
    },
  });

/**
 * Mastodon's `WellKnown::WebfingerController`. The resource forms are
 * `webFingerResource`'s; a deleted account is gone (410).
 * Served by `app/middleware/03.well-known.ts` (no route file: Void skips dot directories).
 */
export const getWellKnownWebfinger = async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const named = webFingerResource(identity.value, c.req.query("resource") ?? "");
  switch (named.kind) {
    case "Invalid":
      return webFingerRefusal(400);
    case "NotFound":
      return webFingerRefusal(404);
    case "InstanceActor":
      return webFingerAnswer(instanceActorJrd(identity.value));
    case "Account":
      break;
  }
  const account = await findAccountByUsername(c.env.DB, named.username);
  if (account.isErr()) {
    return jsonRepositoryError(c, account.error.message);
  }
  if (!account.value) {
    const deleted = await isDeletedAccountName(c.env.DB, named.username.toLowerCase());
    if (deleted.isErr()) {
      return jsonRepositoryError(c, deleted.error.message);
    }
    return webFingerRefusal(deleted.value ? 410 : 404);
  }
  const avatar = await webFingerAvatar(c.env, identity.value, account.value);
  if (avatar.isErr()) {
    return jsonRepositoryError(c, avatar.error.message);
  }
  return webFingerAnswer(accountJrd(identity.value, account.value.username, avatar.value));
};

/**
 * Mastodon's `/about/more`, the instance actor's WebFinger `profile-page`:
 * a permanent redirect to the about page.
 */
export const getAboutMore = (c: Context<{ Bindings: Env }, "/about/more">) =>
  pageRedirect(c, "/about", 301);

const webfingerTemplate = (publicOrigin: string): string =>
  `${publicOrigin.replace(/\/$/, "")}/.well-known/webfinger?resource={uri}`;

const escapeXmlAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const HOST_META_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=1500";

/** RFC 6415 host-meta (XRD) with the LRDD WebFinger template, as Mastodon serves it. */
export const getWellKnownHostMeta = (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const template = escapeXmlAttribute(webfingerTemplate(identity.value.publicOrigin));
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<XRD xmlns="http://docs.oasis-open.org/ns/xri/xrd-1.0">\n' +
    `  <Link rel="lrdd" template="${template}"/>\n` +
    "</XRD>\n";
  return c.body(body, 200, {
    "Content-Type": "application/xrd+xml; charset=utf-8",
    "Cache-Control": HOST_META_CACHE_CONTROL,
  });
};

/** The same host-meta as a JRD (`/.well-known/host-meta.json`). */
export const getWellKnownHostMetaJson = (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  return c.body(
    JSON.stringify({
      links: [{ rel: "lrdd", template: webfingerTemplate(identity.value.publicOrigin) }],
    }),
    200,
    { "Content-Type": "application/jrd+json", "Cache-Control": HOST_META_CACHE_CONTROL },
  );
};

export const getWellKnownNodeinfo = (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const discovery: NodeInfoDiscoveryJSON = {
    links: [
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
        href: `${identity.value.publicOrigin.replace(/\/$/, "")}/nodeinfo/2.0`,
      },
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
        href: `${identity.value.publicOrigin.replace(/\/$/, "")}/nodeinfo/2.1`,
      },
    ],
  };
  return c.json(discovery);
};
