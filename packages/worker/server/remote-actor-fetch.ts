import { env } from "cloudflare:workers";
import {
  type AccountHandle,
  Hostname,
  IsoInstant,
  RemoteActor,
  type RemoteActorKey,
  type InstanceIdentity,
  type RemoteActorProfile,
  WebfingerConfirmation,
  type WebfingerConfirmationValue,
  type WebfingerRefusal,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { err, ok, type Result } from "neverthrow";
import { parseAccountHandle } from "./account-handle";
import { nowIso } from "./clock";
import { type RepositoryError, toRepositoryError } from "./d1";
import {
  fetchActivityJson,
  type FederatedFetchError,
  fetchWebfinger,
  type FederatedFetchOptions,
  isFederatedHostRefused,
} from "./federated-fetch";
import { ActorDocumentSchema, refId } from "./activitypub-wire";
import { type PublishedKey, publishedKeys, resolvePublishedKeys } from "./actor-keys";
import { actorFields } from "./remote-actor-fields";
import { actorEmojis } from "./remote-emoji-document";
import { recordProfileEmojis } from "./remote-emoji-refresh";
import {
  claimRemoteActorKeyRefetch,
  claimRemoteActorRefresh,
  findRemoteActorByHandle,
  findRemoteActorByUri,
  findRemoteActorKey,
  releaseRemoteActorHandle,
  type RemoteKeyOwner,
  upsertConfirmedRemoteActor,
  upsertRemoteActorKeepingHandle,
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

/**
 * The character a numeric reference names. One that names no character (zero,
 * a surrogate, a number past U+10FFFF) is U+FFFD, as an HTML parser reads it:
 * `String.fromCodePoint` throws on a number out of range.
 */
const referencedCharacter = (code: number): string =>
  Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
    ? String.fromCodePoint(code)
    : "\ufffd";

/** The text of an actor's HTML `summary`: line breaks kept, every tag dropped. */
export const summaryText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
      .replace(/<[^>]*>/g, ""),
  ).trim();

/** HTML text or an attribute value with its character references read: numeric ones and a few names. */
export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return referencedCharacter(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return referencedCharacter(Number.parseInt(entity.slice(1), 10));
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });

const actorProfile = (
  actorUri: string,
  document: Readonly<{
    name?: string | undefined;
    attachment?: unknown;
    type?: string | undefined;
    summary?: string | null | undefined;
    url?: unknown;
    icon?: unknown;
    image?: unknown;
    manuallyApprovesFollowers?: boolean | null | undefined;
    published?: string | null | undefined;
  }>,
): RemoteActorProfile => {
  const published = IsoInstant.parseRemote(document.published ?? "");
  const note = summaryText(document.summary ?? "");
  const fields = actorFields(document.attachment);
  // As Mastodon's `ProcessAccountService#url`, a `url` on another host is dropped.
  const profileUrl = linkUrl(document.url);
  return {
    note,
    avatarUrl: linkUrl(document.icon),
    headerUrl: linkUrl(document.image),
    profileUrl:
      profileUrl !== null && RemoteActor.sameHost(profileUrl, actorUri) ? profileUrl : null,
    locked: document.manuallyApprovesFollowers === true,
    bot: document.type === "Service" || document.type === "Application",
    publishedAt: published.isOk() ? published.value : null,
    emojis: [
      ...actorEmojis(document, [
        document.name ?? "",
        note,
        ...fields.flatMap((field) => [field.name, field.value]),
      ]),
    ],
    fields,
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
 * The authority SQL reads from a URI's text (`remote_actors.uri_authority`,
 * migration 0107): what follows `://` up to the first `/`, lower-cased, when
 * it is printable ASCII. SQLite's `lower` folds ASCII only, so an actor whose
 * id has another character there (a Unicode host such as the Kelvin sign
 * `\u212A`, which the URL parser reads as `k`) is refused rather than stored
 * under a host no SQL rule would match; so is one whose text reads otherwise
 * than its parsed host and port (userinfo, a backslash, `%` escapes, an
 * explicit default port, a trailing dot).
 */
const textAuthority = (uri: string): string | undefined => {
  const rest = uri.slice(uri.indexOf("://") + 3);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  return /^[\x21-\x7e]+$/.test(authority) ? authority.toLowerCase() : undefined;
};

/**
 * A collection the actor document names (`followers`, `following`), as
 * Mastodon's `valid_collection_uri`: a URI, an object's `id`, or the first of
 * a list, when it is http(s). Unlike Mastodon, it must also be on the actor's
 * own host, so an actor cannot have a quote policy (`canQuote`) match
 * another server's collection as its own.
 */
const ownCollectionUri = (value: unknown, actorUri: URL): string | undefined => {
  const uri = refId(value);
  if (uri === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(uri);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.host === actorUri.host
      ? uri
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * An actor read from its own document, with the keys it publishes (those it
 * names by id not fetched yet), and the handle its FEP-2c59 `webfinger`
 * property declares, when that names one.
 */
export type FetchedRemoteActor = Readonly<{
  actor: RemoteActor;
  publishedKeys: ReadonlyArray<PublishedKey>;
  declaredHandle?: AccountHandle | undefined;
}>;

const DeclaredHandleSchema = z.object({ webfinger: z.unknown().optional() }).passthrough();
const parseDeclaredHandle = schemaResult(DeclaredHandleSchema);

/**
 * The handle an actor document's FEP-2c59 `webfinger` declares, read as
 * Mastodon's `extract_username_and_domain!` splits it: a string with both a
 * username and a domain, the domain lowercased. Anything else declares none,
 * and the round trip starts from `preferredUsername` at the URI's authority.
 */
const declaredHandleOf = (raw: unknown): AccountHandle | undefined => {
  const document = parseDeclaredHandle(raw);
  const declared = document.isOk() ? document.value.webfinger : undefined;
  if (typeof declared !== "string") {
    return undefined;
  }
  const handle = domainHandle(declared);
  return handle && handle.username !== "" && handle.domain !== ""
    ? { username: handle.username, domain: handle.domain.toLowerCase() }
    : undefined;
};

/**
 * An actor document that describes `actorUri`, and the keys it publishes
 * ({@link publishedKeys}). `storedUsername` is the username the actor is
 * cached under, when it is.
 */
export const remoteActorFromDocument = (
  raw: unknown,
  actorUri: string,
  storedUsername?: string,
): Result<FetchedRemoteActor, RemoteActorResolveError> => {
  const document = parseActorDocument(raw);
  if (document.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  if (document.value.id !== actorUri) {
    return err({ kind: "InvalidSignature" });
  }
  // Mastodon's `Account` validates a remote username when it changes
  // (`will_save_change_to_username?`), so it stores no account under one
  // that does not match, and keeps refreshing one it already holds. The
  // username is stored lowercased, so it is compared lowercased.
  if (
    document.value.preferredUsername.toLowerCase() !== storedUsername &&
    !RemoteActor.acceptsUsername(document.value.preferredUsername)
  ) {
    return err({ kind: "InvalidSignature" });
  }
  let parsedUri: URL;
  try {
    parsedUri = new URL(document.value.id);
  } catch {
    return err({ kind: "InvalidSignature" });
  }
  const uriHost = Hostname.ofUri(document.value.id);
  if (uriHost === undefined) {
    return err({ kind: "InvalidSignature" });
  }
  const domain = parsedUri.port === "" ? uriHost : `${uriHost}:${parsedUri.port}`;
  if (textAuthority(document.value.id) !== domain) {
    return err({ kind: "InvalidSignature" });
  }
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  const actor = RemoteActor.fromFetched({
    actorUri: document.value.id,
    username: document.value.preferredUsername.toLowerCase(),
    domain,
    inboxUri: document.value.inbox,
    displayName: document.value.name ?? document.value.preferredUsername,
    profile: actorProfile(document.value.id, document.value),
    fetchedAt: fetchedAt.value,
    ...(document.value.endpoints?.sharedInbox
      ? { sharedInboxUri: document.value.endpoints.sharedInbox }
      : {}),
    outboxUri: linkUrl(document.value.outbox) ?? undefined,
    featuredUri: linkUrl(document.value.featured) ?? undefined,
    featuredTagsUri: linkUrl(document.value.featuredTags) ?? undefined,
    followersUri: ownCollectionUri(document.value.followers, parsedUri),
    followingUri: ownCollectionUri(document.value.following, parsedUri),
  });
  const keys = publishedKeys(raw, actorUri);
  if (actor.isErr() || keys.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  return ok({
    actor: actor.value,
    publishedKeys: keys.value,
    declaredHandle: declaredHandleOf(raw),
  });
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

/**
 * A WebFinger lookup: the account its `subject` names and its `self` link;
 * `Disowned` when the server answered 404 or 410; `Failed` when nothing is
 * known (a timeout, a 5xx, a redirect it does not follow, any other 4xx, an
 * unreadable answer, no `self` link). `supportedUsername` is false when the
 * subject's username, the part before its first `@` as Mastodon's
 * `split_acct` reads it, is one `Account::USERNAME_ONLY_RE` does not match.
 */
type WebfingerLookup =
  | Readonly<{
      kind: "Answered";
      subject: AccountHandle | undefined;
      self: string;
      supportedUsername: boolean;
    }>
  | Readonly<{ kind: "Disowned" }>
  | Readonly<{ kind: "Failed"; error: FederatedFetchError }>;

const subjectUsernameSupported = (subject: string | undefined): boolean =>
  subject === undefined ||
  RemoteActor.acceptsUsername(subject.replace(/^acct:/, "").split("@")[0] ?? "");

const lookUp = async (
  identity: InstanceIdentity,
  handle: AccountHandle,
  options: FederatedFetchOptions,
): Promise<WebfingerLookup> => {
  const answer = await fetchWebfinger(identity, `${handle.username}@${handle.domain}`, options);
  if (answer.isErr()) {
    return answer.error.kind === "NoSuchAccount"
      ? { kind: "Disowned" }
      : { kind: "Failed", error: answer.error };
  }
  return {
    kind: "Answered",
    subject: domainHandle(answer.value.subject),
    self: answer.value.self,
    supportedUsername: subjectUsernameSupported(answer.value.subject),
  };
};

/** A WebFinger answer for `handle` that names it and links back to `actorUri`. */
const loopsBack = (lookup: WebfingerLookup, handle: AccountHandle, actorUri: string): boolean =>
  lookup.kind === "Answered" &&
  lookup.subject !== undefined &&
  sameHandle(lookup.subject, handle) &&
  lookup.self === actorUri;

/** What a lookup that answered nothing usable means for the round trip. */
const unanswered = (
  lookup: Exclude<WebfingerLookup, { kind: "Answered" }>,
): WebfingerConfirmationValue =>
  lookup.kind === "Disowned" ? { kind: "Mismatch" } : { kind: "Unavailable" };

/**
 * Mastodon's `check_webfinger!` for an actor read from its own document. The
 * lookup starts at the handle the document declares (`declared`, FEP-2c59), or
 * else at `preferredUsername@<URI authority>`; a `subject` on another
 * domain is taken only when WebFinger on that domain names the same account
 * and links back to the same actor, so an actor cannot claim a domain it does
 * not control. A claimed domain this instance does not federate with is
 * `Refused` before it is asked, as Mastodon's `domain_not_allowed?`.
 * `answered` is a handle whose own WebFinger already named it and linked to
 * this actor (a handle lookup). It stands in for the step that would ask it
 * again: the first when it is the URI authority's handle, otherwise the
 * second, once the URI authority's answer names it. A handle on any other
 * domain settles nothing, so a third party cannot rename another server's
 * actor by pointing its own WebFinger at it.
 *
 * Anything but a confirmation writes nothing (`WebfingerConfirmation.handleWrite`),
 * so a cached actor keeps its stored handle through a failed round trip. The
 * stored handle's own domain decides whether it keeps it: a handle lookup
 * ({@link resolveRemoteActorByHandle}) and a refresh
 * ({@link refreshRemoteActor}) ask it, and take the handle away when it
 * links another actor.
 */
const confirmHandle = async (
  identity: InstanceIdentity,
  actor: RemoteActor,
  declared: AccountHandle | undefined,
  options: FederatedFetchOptions,
  answered: AccountHandle | undefined,
): Promise<WebfingerConfirmationValue> => {
  const confirmed = (
    handle: AccountHandle,
  ): Extract<WebfingerConfirmationValue, { kind: "Confirmed" | "Refused" }> => {
    const host = Hostname.ofAuthority(handle.domain);
    return isFederatedHostRefused(host, identity.domain, options)
      ? { kind: "Refused", host }
      : { kind: "Confirmed", handle: { ...handle, username: handle.username.toLowerCase() } };
  };
  const claimed = declared ?? { username: actor.username, domain: actor.domain };
  const vouched = (handle: AccountHandle): boolean =>
    answered !== undefined && sameHandle(answered, handle);
  const fromUriAuthority = async (): Promise<WebfingerConfirmationValue> => {
    if (vouched(claimed)) {
      return confirmed(claimed);
    }
    // A declared domain is refused before it is asked, as `domain_not_allowed?`.
    const asked = declared === undefined ? undefined : confirmed(claimed);
    if (asked?.kind === "Refused") {
      return asked;
    }
    const first = await lookUp(identity, claimed, options);
    if (first.kind !== "Answered") {
      return unanswered(first);
    }
    // The second lookup must name the same username, so only the first's is checked.
    if (!first.supportedUsername) {
      return { kind: "UnsupportedUsername" };
    }
    if (first.subject === undefined) {
      return { kind: "Mismatch" };
    }
    if (sameHandle(first.subject, claimed)) {
      return loopsBack(first, claimed, actor.actorUri) ? confirmed(claimed) : { kind: "Mismatch" };
    }
    const subject = first.subject;
    const settled = confirmed(subject);
    if (settled.kind === "Refused" || vouched(subject)) {
      return settled;
    }
    const second = await lookUp(identity, subject, options);
    if (second.kind !== "Answered") {
      return unanswered(second);
    }
    return loopsBack(second, subject, actor.actorUri) ? settled : { kind: "Mismatch" };
  };
  return fromUriAuthority();
};

/**
 * How {@link cacheFetchedActor} settles an actor's handle: the WebFinger
 * round trip (`answered` as {@link confirmHandle} takes it), or the stored
 * handle kept as it is, as Mastodon applies an actor's own `Update` under the
 * account's stored handle without asking WebFinger.
 */
export type HandleCheck =
  | Readonly<{ kind: "RoundTrip"; answered?: AccountHandle }>
  | Readonly<{ kind: "KeepStored" }>;

export type CacheFetchedActorError = RepositoryError | WebfingerRefusal | FederatedFetchError;

/**
 * Cache an actor read from its own document, and the keys it publishes
 * ({@link resolvePublishedKeys}, which fetches those it names by id), under
 * the handle the round trip settles (`WebfingerConfirmation.handleWrite`). A
 * confirmed handle is taken from any other row that held it. Nothing is
 * written for an actor whose claimed account domain is refused, one whose
 * keys could not be read, or one WebFinger does not vouch for (a cached one
 * is left as it was), nor for an actor not cached yet whose lookup did not
 * answer: that is a `VerificationUnavailable`, which the caller may retry.
 */
export const cacheFetchedActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  fetched: FetchedRemoteActor,
  options: FederatedFetchOptions,
  check: HandleCheck = { kind: "RoundTrip" },
): Promise<Result<RemoteActor, CacheFetchedActorError>> => {
  const keys = await resolvePublishedKeys(
    identity,
    fetched.actor.actorUri,
    fetched.publishedKeys,
    options,
  );
  return keys.isErr()
    ? err(keys.error)
    : cacheActorWithKeys(db, identity, fetched, keys.value, options, check);
};

/**
 * {@link cacheFetchedActor} once its keys are read, then the profile's emoji
 * ({@link recordProfileEmojis}). The `RefreshRemoteEmoji` job that a
 * replaced image starts is sent on the Worker's own `OUTBOX_PROCESS_QUEUE`,
 * read from `cloudflare:workers`'s global `env`, since the fetch paths carry
 * only `db`: a queue a caller injects elsewhere is not used for that send.
 */
const cacheActorWithKeys = async (
  db: D1Database,
  identity: InstanceIdentity,
  fetched: FetchedRemoteActor,
  keys: ReadonlyArray<RemoteActorKey>,
  options: FederatedFetchOptions,
  check: HandleCheck = { kind: "RoundTrip" },
): Promise<Result<RemoteActor, CacheFetchedActorError>> => {
  const stored = await writeFetchedActor(db, identity, fetched, keys, options, check);
  if (stored.isOk()) {
    await recordProfileEmojis(
      { DB: db, OUTBOX_PROCESS_QUEUE: env.OUTBOX_PROCESS_QUEUE },
      stored.value,
    );
  }
  return stored;
};

const writeFetchedActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  fetched: FetchedRemoteActor,
  keys: ReadonlyArray<RemoteActorKey>,
  options: FederatedFetchOptions,
  check: HandleCheck,
): Promise<Result<RemoteActor, CacheFetchedActorError>> => {
  const { actor, declaredHandle } = fetched;
  const now = IsoInstant.parse(nowIso());
  if (now.isErr()) {
    return err(toRepositoryError("invalid clock"));
  }
  const { webfingeredAt: _fromCaller, ...document } = actor;
  if (check.kind === "KeepStored") {
    return upsertRemoteActorKeepingHandle(db, document, keys);
  }
  const confirmation = await confirmHandle(
    identity,
    actor,
    declaredHandle,
    options,
    check.answered,
  );
  const write = WebfingerConfirmation.handleWrite(confirmation, now.value);
  if (write.isErr()) {
    // A lookup that did not answer is a server that did not answer: the
    // inbox answers 503 and the sender delivers again.
    return err(
      write.error.kind === "WebfingerUnavailable"
        ? { kind: "VerificationUnavailable" }
        : write.error,
    );
  }
  return upsertConfirmedRemoteActor(
    db,
    { ...document, ...write.value.handle, webfingeredAt: write.value.webfingeredAt },
    keys,
  );
};

/**
 * `checkSignature` is given the key a signature names when its actor is
 * fetched because the key was not cached, before the actor's WebFinger round
 * trip or caching; `false` stops both, so an unsigned or forged request
 * reaches no URL but the key's. It is also given a cached key: `false` there
 * means the actor may have rotated it under the same key id, see
 * {@link refetchRotatedKey}.
 */
export type KeyResolveOptions = FederatedFetchOptions &
  Readonly<{ checkSignature?: (key: RemoteActorKey) => Promise<boolean> }>;

/**
 * A cached key that does not verify the request: fetch its actor's document
 * again, once per actor per `KEY_REFETCH_INTERVAL_MS` (`key_refetched_at`), as
 * Mastodon refetches the signer once when a signature fails, so a key the
 * actor rotated under the same key id takes effect on its next request. The
 * refreshed actor and its keys are cached (under its stored handle, as an
 * `Update` of it is), and the key is returned when the actor still publishes
 * it; the caller verifies the request with it. When the refetch is not due,
 * fails, returns the same key or none under its id, the cached key is
 * returned and the request fails to verify, as Mastodon looks the key up
 * among the refetched actor's own.
 */
const refetchRotatedKey = async (
  db: D1Database,
  identity: InstanceIdentity,
  cached: RemoteKeyOwner,
  options: KeyResolveOptions,
): Promise<Result<RemoteKeyOwner, RemoteActorResolveError>> => {
  if (!options.checkSignature || (await options.checkSignature(cached.key))) {
    return ok(cached);
  }
  const actorUri = cached.actor.actorUri;
  const claimed = await claimRemoteActorKeyRefetch(db, actorUri);
  if (claimed.isErr()) {
    return err(claimed.error);
  }
  if (!claimed.value) {
    console.log(JSON.stringify({ kind: "RemoteKeyRefetchThrottled", actorUri }));
    return ok(cached);
  }
  const fetched = await fetchActivityJson(identity, actorUri, options);
  if (fetched.isErr()) {
    return ok(cached);
  }
  const refreshed = remoteActorFromDocument(fetched.value, actorUri, cached.actor.username);
  if (refreshed.isErr()) {
    return ok(cached);
  }
  const keys = await resolvePublishedKeys(
    identity,
    actorUri,
    refreshed.value.publishedKeys,
    options,
  );
  if (keys.isErr()) {
    return ok(cached);
  }
  const key = keys.value.find((candidate) => candidate.keyId === cached.key.keyId);
  if (key?.kind === cached.key.kind && key.publicKeyPem === cached.key.publicKeyPem) {
    return ok(cached);
  }
  const stored = await cacheActorWithKeys(db, identity, refreshed.value, keys.value, options, {
    kind: "KeepStored",
  });
  if (stored.isErr()) {
    return err(stored.error);
  }
  console.log(
    JSON.stringify({ kind: "RemoteKeyRefetched", actorUri, keyIdKept: key !== undefined }),
  );
  return ok(key === undefined ? cached : { actor: stored.value, key });
};

/**
 * The key `keyId` names and the actor that owns it, as Mastodon finds the key
 * a signature names (`Keypair.from_keyid`, else `FetchRemoteKeyService`): the
 * cached key (refetched once if it rotated, see {@link refetchRotatedKey}),
 * or else the key fetched with its actor. The actor is whoever owns the key,
 * whatever the request names: the inbox compares it with the activity's
 * actor, and a request signed by another actor is a forward.
 */
export const resolveKeyOwner = async (
  db: D1Database,
  identity: InstanceIdentity,
  keyId: string,
  options: KeyResolveOptions,
): Promise<Result<RemoteKeyOwner, RemoteActorResolveError>> => {
  const cached = await findRemoteActorKey(db, keyId);
  if (cached.isErr()) {
    return err(cached.error);
  }
  return cached.value
    ? refetchRotatedKey(db, identity, cached.value, options)
    : fetchKeyOwner(db, identity, keyId, options);
};

/**
 * The actor at `actorUri`: cached, or else fetched and cached after the
 * WebFinger round trip. Nothing is verified with its keys.
 */
export const resolveRemoteActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  actorUri: string,
  options: FederatedFetchOptions,
): Promise<Result<RemoteActor, RemoteActorResolveError>> => {
  const cached = await findRemoteActorByUri(db, actorUri);
  if (cached.isErr()) {
    return err(cached.error);
  }
  return cached.value ? ok(cached.value) : refetchRemoteActor(db, identity, actorUri, options);
};

/**
 * A key fetched on its own (not inside its actor's document): a FEP-521a
 * `Multikey` with its `controller`, or a `publicKey` object with its `owner`,
 * as Mastodon's `FetchRemoteKeyService#public_key?` tells one.
 */
const KeyDocumentSchema = z.object({
  id: z.string(),
  type: z.unknown().optional(),
  inbox: z.never().optional(),
  owner: z.unknown().optional(),
  controller: z.unknown().optional(),
  publicKeyPem: z.string().min(1).optional(),
  publicKeyMultibase: z.string().min(1).optional(),
});

/**
 * The id a key document gives itself and the actor it says owns it;
 * `undefined` for any other document.
 */
const keyDocumentOwner = (raw: unknown): Readonly<{ id: string; ownerUri: string }> | undefined => {
  const parsed = KeyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const document = parsed.data;
  const multikey = document.type === "Multikey";
  const ownerUri = refId(multikey ? document.controller : document.owner);
  const key = multikey ? document.publicKeyMultibase : document.publicKeyPem;
  return ownerUri === undefined || key === undefined ? undefined : { id: document.id, ownerUri };
};

const DocumentIdSchema = z.object({ id: z.string() });

/**
 * The actor whose document was served at `keyId`. A document whose `id` is
 * not `keyId` without its fragment is read again from that `id`, on the same
 * host, and only that copy counts, as Mastodon's `fetch_resource` with
 * `allow_redirects` takes a document only from its own URL: a document served
 * at some other path of a host cannot speak for an actor there.
 */
const actorServedAt = async (
  identity: InstanceIdentity,
  keyId: string,
  raw: unknown,
  options: KeyResolveOptions,
): Promise<Result<FetchedRemoteActor, RemoteActorResolveError>> => {
  const named = DocumentIdSchema.safeParse(raw);
  if (!named.success) {
    return err({ kind: "InvalidSignature" });
  }
  const actorUri = named.data.id;
  if (actorUri === keyId.split("#")[0]) {
    return remoteActorFromDocument(raw, actorUri);
  }
  if (Hostname.ofUri(actorUri) !== Hostname.ofUri(keyId)) {
    return err({ kind: "InvalidSignature" });
  }
  const own = await fetchActivityJson(identity, actorUri, options);
  return own.isErr() ? err(own.error) : remoteActorFromDocument(own.value, actorUri);
};

/**
 * The actor a key document says owns it, read from its own document on the
 * key's host, as Mastodon's `FetchRemoteKeyService` fetches the `owner`
 * (`controller` for a Multikey).
 */
const keyDocumentActor = async (
  identity: InstanceIdentity,
  keyId: string,
  keyDocument: Readonly<{ id: string; ownerUri: string }>,
  options: KeyResolveOptions,
): Promise<Result<FetchedRemoteActor, RemoteActorResolveError>> => {
  if (keyDocument.id !== keyId || Hostname.ofUri(keyDocument.ownerUri) !== Hostname.ofUri(keyId)) {
    return err({ kind: "InvalidSignature" });
  }
  const own = await fetchActivityJson(identity, keyDocument.ownerUri, options);
  return own.isErr() ? err(own.error) : remoteActorFromDocument(own.value, keyDocument.ownerUri);
};

/**
 * Fetch `keyId` and the actor that owns it, and cache that actor once the key
 * is its own and passes `checkSignature`, as Mastodon's
 * `FetchRemoteKeyService`: the document at `keyId` is the actor's own (see
 * {@link actorServedAt}), or a key document whose owner (`controller` for a
 * Multikey) is fetched. Either way the key is taken only when it is among the
 * keys the actor's document publishes ({@link resolvePublishedKeys}), as
 * Mastodon looks it up among the keys `ProcessAccountService` stored; the
 * document already fetched at `keyId` is not fetched again.
 */
const fetchKeyOwner = async (
  db: D1Database,
  identity: InstanceIdentity,
  keyId: string,
  options: KeyResolveOptions,
): Promise<Result<RemoteKeyOwner, RemoteActorResolveError>> => {
  const fetched = await fetchActivityJson(identity, keyId, options);
  if (fetched.isErr()) {
    return err(fetched.error);
  }
  const keyDocument = keyDocumentOwner(fetched.value);
  const read =
    keyDocument === undefined
      ? await actorServedAt(identity, keyId, fetched.value, options)
      : await keyDocumentActor(identity, keyId, keyDocument, options);
  if (read.isErr()) {
    return err(read.error);
  }
  const actor = read.value;
  // A document speaks only for its own host: one served at a key URL on
  // another host than the actor it describes could rewrite that actor's key.
  if (Hostname.ofUri(actor.actor.actorUri) !== Hostname.ofUri(keyId)) {
    return err({ kind: "InvalidSignature" });
  }
  const keys = await resolvePublishedKeys(
    identity,
    actor.actor.actorUri,
    actor.publishedKeys,
    options,
    new Map([[keyId, fetched.value]]),
  );
  if (keys.isErr()) {
    return err(keys.error);
  }
  const key = keys.value.find((candidate) => candidate.keyId === keyId);
  if (key === undefined || (options.checkSignature && !(await options.checkSignature(key)))) {
    return err({ kind: "InvalidSignature" });
  }
  const stored = await cacheActorWithKeys(db, identity, actor, keys.value, options);
  return stored.map((cached) => ({ actor: cached, key }));
};

/** A fetch that got no usable document, as opposed to a refusal or a storage error. */
const unreachable = (error: RemoteActorResolveError): boolean =>
  error.kind === "InvalidSignature" || error.kind === "VerificationUnavailable";

/** Fetch `actorUri`'s own document and cache it after the WebFinger round trip. */
const refetchRemoteActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  actorUri: string,
  options: FederatedFetchOptions,
  check: HandleCheck = { kind: "RoundTrip" },
): Promise<Result<RemoteActor, RemoteActorResolveError>> => {
  const fetched = await fetchActivityJson(identity, actorUri, options);
  if (fetched.isErr()) {
    return err(fetched.error);
  }
  const actor = await readCachedActorDocument(db, fetched.value, actorUri);
  if (actor.isErr()) {
    return err(actor.error);
  }
  return cacheFetchedActor(db, identity, actor.value, options, check);
};

/**
 * {@link remoteActorFromDocument} for an actor that may be cached already. A
 * refused document is read again with the username the actor is cached
 * under, so a username Mastodon would refuse now but that the actor already
 * holds does not stop its refreshes. The cached row is read only then.
 */
const readCachedActorDocument = async (
  db: D1Database,
  raw: unknown,
  actorUri: string,
): Promise<Result<FetchedRemoteActor, RemoteActorResolveError>> => {
  const read = remoteActorFromDocument(raw, actorUri);
  if (read.isOk()) {
    return read;
  }
  const cached = await findRemoteActorByUri(db, actorUri);
  if (cached.isErr()) {
    return err(cached.error);
  }
  return cached.value ? remoteActorFromDocument(raw, actorUri, cached.value.username) : read;
};

/**
 * Settle who may hold `handle` from what its own domain's WebFinger said, as
 * Mastodon's `ResolveAccountService` asks the handle side: every confirmed
 * row cached under it but the actor that answer links (none, when the answer
 * names another account or the domain answered 404 or 410) falls back to its
 * URI's authority. A lookup that failed settles nothing. Only the handle's
 * own domain is asked, so no third party can take a handle from anyone.
 */
const settleHandleHolder = async (
  db: D1Database,
  handle: AccountHandle,
  lookup: WebfingerLookup,
): Promise<Result<void, RepositoryError>> => {
  switch (lookup.kind) {
    case "Failed":
      return ok(undefined);
    case "Disowned":
      return releaseRemoteActorHandle(db, handle, undefined);
    case "Answered":
      return releaseRemoteActorHandle(
        db,
        handle,
        lookup.subject && sameHandle(lookup.subject, handle) ? lookup.self : undefined,
      );
  }
};

/**
 * `mayLookUp` is asked right before a handle goes to the network, and a
 * `false` answer settles it from the cache alone: the cached holder, even
 * one due a refresh, or `VerificationUnavailable` when none is cached.
 */
export type HandleResolveOptions = FederatedFetchOptions & Readonly<{ mayLookUp?: () => boolean }>;

/**
 * The actor a `user@domain` handle names, as Mastodon's
 * `ResolveAccountService`. A cached holder of the handle is used as it is
 * until it is due a refresh (a day after its last confirmation and its last
 * attempt, `claimRemoteActorRefresh`); otherwise the handle's own WebFinger
 * is asked, the holders it no longer names give the handle up, and the actor
 * it links is fetched and run through the round trip. While that WebFinger
 * does not answer, a cached holder is kept; while the linked actor's document
 * does not answer, that actor is used as cached. A holder claimed this way is
 * not asked again until the next day.
 */
export const resolveRemoteActorByHandle = async (
  db: D1Database,
  identity: InstanceIdentity,
  handle: string,
  options: HandleResolveOptions,
): Promise<Result<RemoteActor, RemoteActorResolveError>> => {
  const asked = domainHandle(handle);
  if (asked === undefined) {
    return err({ kind: "InvalidSignature" });
  }
  const cached = await findRemoteActorByHandle(db, asked.username, asked.domain);
  if (cached.isErr()) {
    return err(cached.error);
  }
  const holder = cached.value;
  if (holder) {
    const due = await claimRemoteActorRefresh(db, holder.actorUri);
    if (due.isErr()) {
      return err(due.error);
    }
    if (!due.value) {
      return ok(holder);
    }
  }
  if (options.mayLookUp?.() === false) {
    return holder ? ok(holder) : err({ kind: "VerificationUnavailable" });
  }
  const lookup = await lookUp(identity, asked, options);
  if (lookup.kind === "Failed") {
    return holder ? ok(holder) : err(lookup.error);
  }
  if (holder) {
    const settled = await settleHandleHolder(db, asked, lookup);
    if (settled.isErr()) {
      return err(settled.error);
    }
  }
  if (lookup.kind === "Disowned") {
    return err({ kind: "InvalidSignature" });
  }
  // WebFinger on the asked handle's domain named it and linked this actor.
  const answered = lookup.subject && sameHandle(asked, lookup.subject) ? lookup.subject : undefined;
  const fetched = await refetchRemoteActor(
    db,
    identity,
    lookup.self,
    options,
    answered ? { kind: "RoundTrip", answered } : { kind: "RoundTrip" },
  );
  if (fetched.isOk() || !unreachable(fetched.error)) {
    return fetched;
  }
  // The linked actor's document did not answer: the actor as cached, under
  // the handle the settling above left it, if it is cached.
  const linked = await findRemoteActorByUri(db, lookup.self);
  if (linked.isErr()) {
    return err(linked.error);
  }
  return linked.value ? ok(linked.value) : fetched;
};

/**
 * Re-fetch a cached actor and run the round trip again. When that fails
 * (its document or the round trip's lookups do not answer, or WebFinger does
 * not vouch for it) and its handle was confirmed, nothing of the actor is
 * written, and the handle's own WebFinger decides whether it keeps it, as
 * Mastodon's refresh resolves the stored handle (`ResolveAccountService`):
 * an answer that names another account or links another actor takes it away
 * (Mastodon's `invalidate_username!` on the former holder), and a 404, a 410
 * or no answer leaves it.
 */
export const refreshRemoteActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  actorUri: string,
  options: FederatedFetchOptions,
): Promise<Result<void, RepositoryError>> => {
  const fetched = await refetchRemoteActor(db, identity, actorUri, options);
  if (fetched.isOk()) {
    return ok(undefined);
  }
  if (fetched.error.kind === "RepositoryError") {
    return err(fetched.error);
  }
  const stored = await findRemoteActorByUri(db, actorUri);
  if (stored.isErr()) {
    return err(stored.error);
  }
  if (stored.value === undefined || stored.value.webfingeredAt === undefined) {
    return ok(undefined);
  }
  const handle = { username: stored.value.username, domain: stored.value.domain };
  const lookup = await lookUp(identity, handle, options);
  return lookup.kind === "Answered" ? settleHandleHolder(db, handle, lookup) : ok(undefined);
};
