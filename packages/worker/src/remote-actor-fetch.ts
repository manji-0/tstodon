import {
  IsoInstant,
  RemoteActor,
  type InstanceIdentity,
  type RemoteActorProfile,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { parseAccountHandle } from "./account-handle";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { fetchActivityJson, fetchWebfinger, type FederatedFetchOptions } from "./federated-fetch";
import { ActorDocumentSchema } from "./activitypub-wire";
import {
  findRemoteActorByPublicKeyId,
  findRemoteActorByUri,
  upsertRemoteActor,
} from "./remote-actor-store";

export type RemoteActorResolveError =
  | Readonly<{ kind: "InvalidSignature" }>
  | Readonly<{ kind: "VerificationUnavailable" }>
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
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  const actor = RemoteActor.fromFetched({
    actorUri: document.value.id,
    username: document.value.preferredUsername.toLowerCase(),
    domain: parsedUri.host.toLowerCase(),
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

type Handle = Readonly<{ username: string; domain: string }>;

const sameHandle = (a: Handle, b: Handle): boolean =>
  a.username.toLowerCase() === b.username.toLowerCase() &&
  a.domain.toLowerCase() === b.domain.toLowerCase();

/** The account a WebFinger lookup of `handle` names, and the actor it links. */
const webfingerSubject = async (
  identity: InstanceIdentity,
  handle: Handle,
  options: FederatedFetchOptions,
): Promise<Readonly<{ subject: Handle; self: string }> | undefined> => {
  const answer = await fetchWebfinger(identity, `${handle.username}@${handle.domain}`, options);
  if (answer.isErr() || answer.value.subject === undefined) {
    return undefined;
  }
  const subject = parseAccountHandle(answer.value.subject.replace(/^acct:/, ""));
  return subject?.domain === undefined
    ? undefined
    : { subject: { username: subject.username, domain: subject.domain }, self: answer.value.self };
};

/**
 * The handle WebFinger confirms for an actor read from its own document, as
 * Mastodon's `check_webfinger!`. The lookup starts at the URI's authority;
 * a `subject` on another domain is taken only when WebFinger on that domain
 * names the same account and links back to the same actor, so an actor
 * cannot claim a domain it does not control. Any other answer keeps the
 * URI's authority, which the actor's document already proves.
 */
const confirmedHandle = async (
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
): Promise<Handle> => {
  const claimed = { username: actor.username, domain: actor.domain };
  const first = await webfingerSubject(identity, claimed, options);
  if (!first || sameHandle(first.subject, claimed)) {
    return claimed;
  }
  const second = await webfingerSubject(identity, first.subject, options);
  return second && sameHandle(second.subject, first.subject) && second.self === actor.actorUri
    ? { username: second.subject.username.toLowerCase(), domain: second.subject.domain }
    : claimed;
};

/** Cache an actor read from its own document, under the handle WebFinger confirms for it. */
export const cacheFetchedActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
): Promise<Result<RemoteActor, RepositoryError>> =>
  upsertRemoteActor(db, { ...actor, ...(await confirmedHandle(identity, actor, options)) });

export const resolveRemoteActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  keyId: string,
  actorUri: string,
  options: FederatedFetchOptions = {},
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
  const stored = await cacheFetchedActor(db, identity, actor.value, options);
  if (stored.isErr()) {
    return err(stored.error);
  }
  return ok(stored.value);
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
  return resolveRemoteActor(db, identity, `${actorUri}#main-key`, actorUri, options);
};
