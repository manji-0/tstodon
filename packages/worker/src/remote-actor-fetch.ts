import {
  type AccountHandle,
  Hostname,
  IsoInstant,
  RemoteActor,
  type InstanceIdentity,
  type RemoteActorProfile,
  WebfingerConfirmation,
  type WebfingerConfirmationValue,
  type WebfingerRefusal,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { parseAccountHandle } from "./account-handle";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import {
  fetchActivityJson,
  fetchWebfinger,
  type FederatedFetchOptions,
  isFederatedHostRefused,
} from "./federated-fetch";
import { ActorDocumentSchema } from "./activitypub-wire";
import {
  findRemoteActorByPublicKeyId,
  findRemoteActorByUri,
  upsertRemoteActor,
} from "./remote-actor-store";

export type RemoteActorResolveError =
  | Readonly<{ kind: "InvalidSignature" }>
  | Readonly<{ kind: "VerificationUnavailable" }>
  | WebfingerRefusal
  | RepositoryError;

const parseActorDocument = schemaResult(ActorDocumentSchema);

/** An http(s) URL from an ActivityPub value: a string, an Image/Link, or the first of a list. */
const linkUrl = (value: unknown): string | null => {
  const first: unknown = Array.isArray(value) ? value[0] : value;
  const candidate: unknown =
    typeof first === "string"
      ? first
      : typeof first === "object" && first !== null
        ? (Reflect.get(first, "url") ?? Reflect.get(first, "href"))
        : undefined;
  if (typeof candidate !== "string") {
    return candidate === undefined ? null : linkUrl(candidate);
  }
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The text of an actor's HTML `summary`: line breaks kept, every tag dropped. */
export const summaryText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .trim();

const actorProfile = (
  document: Readonly<{
    type?: string | undefined;
    summary?: string | null | undefined;
    url?: unknown;
    icon?: unknown;
    image?: unknown;
    manuallyApprovesFollowers?: boolean | null | undefined;
    published?: string | null | undefined;
  }>,
): RemoteActorProfile => {
  const published = IsoInstant.parse(document.published ?? "");
  return {
    note: summaryText(document.summary ?? ""),
    avatarUrl: linkUrl(document.icon),
    headerUrl: linkUrl(document.image),
    profileUrl: linkUrl(document.url),
    locked: document.manuallyApprovesFollowers === true,
    bot: document.type === "Service" || document.type === "Application",
    publishedAt: published.isOk() ? published.value : null,
  };
};

/** The accounts an actor document says it is also (`alsoKnownAs`), as a list. */
export const actorAliases = (raw: unknown): ReadonlyArray<string> => {
  const document = parseActorDocument(raw);
  if (document.isErr()) {
    return [];
  }
  const aliases = document.value.alsoKnownAs;
  return aliases === undefined ? [] : typeof aliases === "string" ? [aliases] : aliases;
};

/** The account an actor document says it moved to; `undefined` when it names none. */
export const actorMovedTo = (raw: unknown): string | undefined => {
  const document = parseActorDocument(raw);
  return document.isOk() ? (document.value.movedTo ?? undefined) : undefined;
};

/**
 * The host SQL reads from a URI's text (`remote_actors.uri_host`, migration
 * 0107): what follows `://` up to the first `/`, as `Hostname.ofAuthority`
 * reads it. An actor URI whose parsed host differs (userinfo, an IDN, a
 * backslash) is refused, so an instance rule on its host never misses it in SQL.
 */
const textUriHost = (uri: string): Hostname => {
  const rest = uri.slice(uri.indexOf("://") + 3);
  const slash = rest.indexOf("/");
  return Hostname.ofAuthority(slash < 0 ? rest : rest.slice(0, slash));
};

/** An actor document that describes `actorUri` and holds that actor's own key. */
export const remoteActorFromDocument = (
  raw: unknown,
  actorUri: string,
): Result<RemoteActor, RemoteActorResolveError> => {
  const document = parseActorDocument(raw);
  if (document.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  if (document.value.id !== actorUri || document.value.publicKey.owner !== actorUri) {
    return err({ kind: "InvalidSignature" });
  }
  let parsedUri: URL;
  try {
    parsedUri = new URL(document.value.id);
  } catch {
    return err({ kind: "InvalidSignature" });
  }
  const uriHost = Hostname.ofUri(document.value.id);
  if (uriHost === undefined || textUriHost(document.value.id) !== uriHost) {
    return err({ kind: "InvalidSignature" });
  }
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  const actor = RemoteActor.fromFetched({
    actorUri: document.value.id,
    username: document.value.preferredUsername.toLowerCase(),
    domain: parsedUri.port === "" ? uriHost : `${uriHost}:${parsedUri.port}`,
    inboxUri: document.value.inbox,
    publicKeyId: document.value.publicKey.id,
    publicKeyPem: document.value.publicKey.publicKeyPem,
    displayName: document.value.name ?? document.value.preferredUsername,
    profile: actorProfile(document.value),
    fetchedAt: fetchedAt.value,
    ...(document.value.endpoints?.sharedInbox
      ? { sharedInboxUri: document.value.endpoints.sharedInbox }
      : {}),
    outboxUri: linkUrl(document.value.outbox) ?? undefined,
    featuredUri: linkUrl(document.value.featured) ?? undefined,
  });
  if (actor.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  return ok(actor.value);
};

const sameHandle = (a: AccountHandle, b: AccountHandle): boolean =>
  a.username.toLowerCase() === b.username.toLowerCase() &&
  a.domain.toLowerCase() === b.domain.toLowerCase();

/** The handle `raw` (an `acct:` URI or `user@domain`) names, when it names a domain. */
const domainHandle = (raw: string | undefined): AccountHandle | undefined => {
  const parsed = parseAccountHandle((raw ?? "").replace(/^acct:/, ""));
  return parsed?.domain === undefined
    ? undefined
    : { username: parsed.username, domain: parsed.domain };
};

/** A WebFinger lookup: the account its `subject` names and its `self` link, or why there is none. */
type WebfingerLookup =
  | Readonly<{ kind: "Answered"; subject: AccountHandle | undefined; self: string }>
  | Readonly<{ kind: "Failed" }>;

const lookUp = async (
  identity: InstanceIdentity,
  handle: AccountHandle,
  options: FederatedFetchOptions,
): Promise<WebfingerLookup> => {
  const answer = await fetchWebfinger(identity, `${handle.username}@${handle.domain}`, options);
  if (answer.isErr()) {
    return { kind: "Failed" };
  }
  return { kind: "Answered", subject: domainHandle(answer.value.subject), self: answer.value.self };
};

/** A WebFinger answer for `handle` that names it and links back to `actorUri`. */
const loopsBack = (lookup: WebfingerLookup, handle: AccountHandle, actorUri: string): boolean =>
  lookup.kind === "Answered" &&
  lookup.subject !== undefined &&
  sameHandle(lookup.subject, handle) &&
  lookup.self === actorUri;

/**
 * Mastodon's `check_webfinger!` for an actor read from its own document. The
 * lookup starts at the URI's authority; a `subject` on another domain is
 * taken only when WebFinger on that domain names the same account and links
 * back to the same actor, so an actor cannot claim a domain it does not
 * control. A claimed domain this instance does not federate with is
 * `Refused` before it is asked, as Mastodon's `domain_not_allowed?`.
 * `confirmedBy` is a handle whose own WebFinger already linked to this actor
 * (a handle lookup), which settles the round trip without asking again.
 */
const confirmHandle = async (
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
  confirmedBy: AccountHandle | undefined,
): Promise<WebfingerConfirmationValue> => {
  const refused = (handle: AccountHandle): WebfingerConfirmationValue | undefined => {
    const host = Hostname.ofAuthority(handle.domain);
    return isFederatedHostRefused(host, identity.domain, options)
      ? { kind: "Refused", host }
      : undefined;
  };
  if (confirmedBy) {
    return refused(confirmedBy) ?? { kind: "Confirmed", handle: confirmedBy };
  }
  const claimed = { username: actor.username, domain: actor.domain };
  const first = await lookUp(identity, claimed, options);
  if (first.kind === "Failed") {
    return { kind: "Unavailable" };
  }
  if (first.subject === undefined) {
    return { kind: "Mismatch" };
  }
  if (sameHandle(first.subject, claimed)) {
    return loopsBack(first, claimed, actor.actorUri)
      ? { kind: "Confirmed", handle: claimed }
      : { kind: "Mismatch" };
  }
  const subject = first.subject;
  const denied = refused(subject);
  if (denied) {
    return denied;
  }
  const second = await lookUp(identity, subject, options);
  if (second.kind === "Failed") {
    return { kind: "Unavailable" };
  }
  return loopsBack(second, subject, actor.actorUri)
    ? {
        kind: "Confirmed",
        handle: { username: subject.username.toLowerCase(), domain: subject.domain },
      }
    : { kind: "Mismatch" };
};

export type CacheFetchedActorError = RepositoryError | WebfingerRefusal;

/**
 * Cache an actor read from its own document, under the handle WebFinger
 * confirms for it (`WebfingerConfirmation.handleToCache`). An actor whose
 * claimed account domain is refused is not cached.
 */
export const cacheFetchedActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
  confirmedBy?: AccountHandle,
): Promise<Result<RemoteActor, CacheFetchedActorError>> => {
  const stored = await findRemoteActorByUri(db, actor.actorUri);
  if (stored.isErr()) {
    return err(stored.error);
  }
  const handle = WebfingerConfirmation.handleToCache(
    await confirmHandle(identity, actor, options, confirmedBy),
    { username: actor.username, domain: actor.domain },
    stored.value ? { username: stored.value.username, domain: stored.value.domain } : undefined,
  );
  if (handle.isErr()) {
    return err(handle.error);
  }
  return upsertRemoteActor(db, { ...actor, ...handle.value });
};

export const resolveRemoteActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  keyId: string,
  actorUri: string,
  options: FederatedFetchOptions = {},
  confirmedBy?: AccountHandle,
): Promise<Result<RemoteActor, RemoteActorResolveError>> => {
  const byKey = await findRemoteActorByPublicKeyId(db, keyId);
  if (byKey.isErr()) {
    return err(byKey.error);
  }
  if (byKey.value && byKey.value.actorUri === actorUri) {
    return ok(byKey.value);
  }
  const byUri = await findRemoteActorByUri(db, actorUri);
  if (byUri.isErr()) {
    return err(byUri.error);
  }
  if (byUri.value && byUri.value.publicKeyId === keyId) {
    return ok(byUri.value);
  }
  const fetched = await fetchActivityJson(identity, keyId, options);
  if (fetched.isErr()) {
    return err(fetched.error);
  }
  const actor = remoteActorFromDocument(fetched.value, actorUri);
  if (actor.isErr()) {
    return err(actor.error);
  }
  if (
    actor.value.publicKeyId !== keyId &&
    actor.value.actorUri !== keyId &&
    `${actor.value.actorUri}#main-key` !== keyId
  ) {
    return err({ kind: "InvalidSignature" });
  }
  return cacheFetchedActor(db, identity, actor.value, options, confirmedBy);
};

/** Resolve and cache a `user@domain` handle by WebFinger, then fetch its actor. */
export const resolveRemoteActorByHandle = async (
  db: D1Database,
  identity: InstanceIdentity,
  handle: string,
  options: FederatedFetchOptions = {},
): Promise<Result<RemoteActor, RemoteActorResolveError>> => {
  const answer = await fetchWebfinger(identity, handle, options);
  if (answer.isErr()) {
    return err(answer.error);
  }
  const actorUri = answer.value.self;
  // WebFinger on the handle's own domain named it and linked this actor.
  const asked = domainHandle(handle);
  const subject = domainHandle(answer.value.subject);
  const confirmedBy =
    asked && subject && sameHandle(asked, subject)
      ? { username: subject.username.toLowerCase(), domain: subject.domain }
      : undefined;
  return resolveRemoteActor(db, identity, `${actorUri}#main-key`, actorUri, options, confirmedBy);
};
