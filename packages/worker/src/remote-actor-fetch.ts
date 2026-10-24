import {
  IsoInstant,
  RemoteActor,
  type InstanceIdentity,
  type RemoteActorProfile,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import {
  fetchActivityJson,
  fetchWebfingerActorUri,
  type FederatedFetchOptions,
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
  | RepositoryError;

const parseActorDocument = schemaResult(ActorDocumentSchema);

/** An http(s) URL from an ActivityPub value: a string, an Image/Link, or the first of a list. */
const linkUrl = (value: unknown): string | null => {
  const first = Array.isArray(value) ? value[0] : value;
  const candidate =
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

const remoteActorFromDocument = (
  raw: unknown,
  keyId: string,
  actorUri: string,
): Result<RemoteActor, RemoteActorResolveError> => {
  const document = parseActorDocument(raw);
  if (document.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  if (document.value.id !== actorUri || document.value.publicKey.owner !== actorUri) {
    return err({ kind: "InvalidSignature" });
  }
  if (
    document.value.publicKey.id !== keyId &&
    document.value.id !== keyId &&
    `${document.value.id}#main-key` !== keyId
  ) {
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
    domain: parsedUri.hostname.toLowerCase(),
    inboxUri: document.value.inbox,
    publicKeyId: document.value.publicKey.id,
    publicKeyPem: document.value.publicKey.publicKeyPem,
    displayName: document.value.name ?? document.value.preferredUsername,
    profile: actorProfile(document.value),
    fetchedAt: fetchedAt.value,
    ...(document.value.endpoints?.sharedInbox
      ? { sharedInboxUri: document.value.endpoints.sharedInbox }
      : {}),
  });
  if (actor.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  return ok(actor.value);
};

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
  const actor = remoteActorFromDocument(fetched.value, keyId, actorUri);
  if (actor.isErr()) {
    return err(actor.error);
  }
  const stored = await upsertRemoteActor(db, actor.value);
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
  const actorUri = await fetchWebfingerActorUri(identity, handle, options);
  if (actorUri.isErr()) {
    return err(actorUri.error);
  }
  return resolveRemoteActor(db, identity, `${actorUri.value}#main-key`, actorUri.value, options);
};
