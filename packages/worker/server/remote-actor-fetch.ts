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
import { actorKeys } from "./actor-keys";
import { multibaseKey } from "./multibase";
import { actorFields } from "./remote-actor-fields";
import { actorEmojis } from "./remote-emoji-document";
import {
  claimRemoteActorKeyRefetch,
  claimRemoteActorRefresh,
  findRemoteActorByHandle,
  findRemoteActorByUri,
  findRemoteActorKey,
  releaseRemoteActorHandle,
  type RemoteKeyOwner,
  upsertConfirmedRemoteActor,
  upsertRemoteActor,
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
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return referencedCharacter(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return referencedCharacter(Number.parseInt(entity.slice(1), 10));
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .trim();

const actorProfile = (
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
  return {
    note,
    avatarUrl: linkUrl(document.icon),
    headerUrl: linkUrl(document.image),
    profileUrl: linkUrl(document.url),
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

/** An actor read from its own document, with the keys it publishes. */
export type FetchedRemoteActor = Readonly<{
  actor: RemoteActor;
  keys: ReadonlyArray<RemoteActorKey>;
}>;

/**
 * An actor document that describes `actorUri`, and the keys it publishes
 * ({@link actorKeys}). `storedUsername` is the username the actor is cached
 * under, when it is.
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
    profile: actorProfile(document.value),
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
  if (actor.isErr()) {
    return err({ kind: "InvalidSignature" });
  }
  return ok({ actor: actor.value, keys: actorKeys(raw, actorUri) });
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

/**
 * How the lookups from the URI authority ended: as the round trip settles
 * it, or `Unavailable` with the handle whose lookup failed.
 */
type UriSideTrip =
  | Exclude<WebfingerConfirmationValue, { kind: "Unavailable" }>
  | Readonly<{ kind: "Unavailable"; pending: AccountHandle }>;

/** What a lookup of `handle` that answered nothing usable means for the round trip. */
const unanswered = (
  lookup: Exclude<WebfingerLookup, { kind: "Answered" }>,
  handle: AccountHandle,
): UriSideTrip =>
  lookup.kind === "Disowned" ? { kind: "Mismatch" } : { kind: "Unavailable", pending: handle };

/**
 * Mastodon's `check_webfinger!` for an actor read from its own document. The
 * lookup starts at `preferredUsername@<URI authority>`; a `subject` on another
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
 * `stored` is the handle cached for the actor. When it is on another domain
 * and the lookups from the URI authority fail anywhere but at that domain
 * (the URI host does not answer, or names a domain that does not), only that
 * domain can keep it, as Mastodon's `ResolveAccountService` asks the account
 * domain: the stored handle stays when its own WebFinger names it and links
 * to this actor, is `Unavailable` while that domain does not answer, and is a
 * `Mismatch` on any other answer. A URI host therefore cannot keep a domain
 * that disowns it by failing its own lookups: only a failure at the stored
 * handle's own domain, which the URI host does not control, keeps it.
 */
const confirmHandle = async (
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
  answered: AccountHandle | undefined,
  stored: AccountHandle | undefined,
): Promise<WebfingerConfirmationValue> => {
  const confirmed = (
    handle: AccountHandle,
  ): Extract<WebfingerConfirmationValue, { kind: "Confirmed" | "Refused" }> => {
    const host = Hostname.ofAuthority(handle.domain);
    return isFederatedHostRefused(host, identity.domain, options)
      ? { kind: "Refused", host }
      : { kind: "Confirmed", handle: { ...handle, username: handle.username.toLowerCase() } };
  };
  const claimed = { username: actor.username, domain: actor.domain };
  const vouched = (handle: AccountHandle): boolean =>
    answered !== undefined && sameHandle(answered, handle);
  const fromUriAuthority = async (): Promise<UriSideTrip> => {
    if (vouched(claimed)) {
      return confirmed(claimed);
    }
    const first = await lookUp(identity, claimed, options);
    if (first.kind !== "Answered") {
      return unanswered(first, claimed);
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
      return unanswered(second, subject);
    }
    return loopsBack(second, subject, actor.actorUri) ? settled : { kind: "Mismatch" };
  };
  const trip = await fromUriAuthority();
  if (trip.kind !== "Unavailable") {
    return trip;
  }
  const foreign =
    stored && stored.domain.toLowerCase() !== claimed.domain.toLowerCase() ? stored : undefined;
  if (foreign === undefined || sameHandle(trip.pending, foreign)) {
    return { kind: "Unavailable" };
  }
  const kept = confirmed(foreign);
  if (kept.kind === "Refused" || vouched(foreign)) {
    return kept;
  }
  const own = await lookUp(identity, foreign, options);
  if (own.kind === "Failed") {
    return { kind: "Unavailable" };
  }
  return loopsBack(own, foreign, actor.actorUri) ? kept : { kind: "Mismatch" };
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

export type CacheFetchedActorError = RepositoryError | WebfingerRefusal;

/**
 * Cache an actor read from its own document, and the keys it publishes, under
 * the handle the round trip settles (`WebfingerConfirmation.handleWrite`). A
 * confirmed handle is taken from any other row that held it. An actor whose
 * claimed account domain is refused is not cached, nor is one not cached yet
 * that WebFinger does not vouch for.
 */
export const cacheFetchedActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  fetched: FetchedRemoteActor,
  options: FederatedFetchOptions,
  check: HandleCheck = { kind: "RoundTrip" },
): Promise<Result<RemoteActor, CacheFetchedActorError>> => {
  const { actor, keys } = fetched;
  const now = IsoInstant.parse(nowIso());
  if (now.isErr()) {
    return err(toRepositoryError("invalid clock"));
  }
  const { webfingeredAt: _fromCaller, ...document } = actor;
  if (check.kind === "KeepStored") {
    return upsertRemoteActorKeepingHandle(db, document, keys);
  }
  const stored = await findRemoteActorByUri(db, actor.actorUri);
  if (stored.isErr()) {
    return err(stored.error);
  }
  const confirmation = await confirmHandle(
    identity,
    actor,
    options,
    check.answered,
    stored.value && { username: stored.value.username, domain: stored.value.domain },
  );
  const write = WebfingerConfirmation.handleWrite(
    confirmation,
    now.value,
    stored.value === undefined ? "FirstSeen" : "Cached",
  );
  if (write.isErr()) {
    return err(write.error);
  }
  switch (write.value.kind) {
    case "Confirm":
      return upsertConfirmedRemoteActor(
        db,
        { ...document, ...write.value.handle, webfingeredAt: write.value.webfingeredAt },
        keys,
      );
    case "UriAuthority":
      return upsertRemoteActor(db, document, keys);
    case "Keep":
      return upsertRemoteActorKeepingHandle(db, document, keys);
  }
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
 * it, or read as an unknown key is ({@link fetchKeyOwner}) when its document
 * does not give it; the caller verifies the request with it. When the refetch is not due,
 * fails, or returns the same key, the cached key is returned and the request
 * fails to verify.
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
  const key = refreshed.value.keys.find((candidate) => candidate.keyId === cached.key.keyId);
  if (key?.kind === cached.key.kind && key.publicKeyPem === cached.key.publicKeyPem) {
    return ok(cached);
  }
  const stored = await cacheFetchedActor(db, identity, refreshed.value, options, {
    kind: "KeepStored",
  });
  if (stored.isErr()) {
    return err(stored.error);
  }
  console.log(
    JSON.stringify({ kind: "RemoteKeyRefetched", actorUri, keyIdKept: key !== undefined }),
  );
  // A key the actor's document does not give in full (GoToSocial's
  // `/main-key`) is read again from its own URL.
  return key === undefined
    ? fetchKeyOwner(db, identity, cached.key.keyId, options)
    : ok({ actor: stored.value, key });
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
 * as Mastodon's `FetchRemoteKeyService` reads one.
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
 * The key a key document holds, whose it says it is, and the list of the
 * owner's document that must name it; `undefined` for any other document.
 */
const keyDocumentKey = (
  raw: unknown,
):
  | Readonly<{ ownerUri: string; key: RemoteActorKey; listedIn: "assertionMethod" | "publicKey" }>
  | undefined => {
  const parsed = KeyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  const document = parsed.data;
  if (document.type === "Multikey") {
    const ownerUri = refId(document.controller);
    const key =
      document.publicKeyMultibase === undefined
        ? undefined
        : multibaseKey(document.publicKeyMultibase);
    return ownerUri === undefined || key === undefined
      ? undefined
      : { ownerUri, key: { ...key, keyId: document.id }, listedIn: "assertionMethod" };
  }
  const ownerUri = refId(document.owner);
  return ownerUri === undefined || document.publicKeyPem === undefined
    ? undefined
    : {
        ownerUri,
        key: { kind: "Rsa", keyId: document.id, publicKeyPem: document.publicKeyPem },
        listedIn: "publicKey",
      };
};

/** Whether an actor document's `list` names `keyId`, given in full or by id (`confirmed_owner?`). */
const listsKey = (raw: unknown, list: "assertionMethod" | "publicKey", keyId: string): boolean => {
  const listed: unknown = typeof raw === "object" && raw !== null ? Reflect.get(raw, list) : [];
  return (Array.isArray(listed) ? listed : [listed]).some((value) => refId(value) === keyId);
};

const DocumentIdSchema = z.object({ id: z.string() });

/** An actor and the key a signature names, read from what was fetched for the key. */
type FetchedKey = Readonly<{ actor: FetchedRemoteActor; key: RemoteActorKey }>;

const ServedPublicKeySchema = z.object({
  id: z.string(),
  owner: z.string(),
  publicKeyPem: z.string().min(1),
});

/**
 * The `publicKey` the document served at `keyId` gives for `keyId` and
 * `actorUri`: the document itself, or the first of its `publicKey` (what
 * GoToSocial serves at its `/main-key`), as Mastodon's
 * `ProcessAccountService#legacy_public_keys` reads a key it fetches.
 */
const publicKeyServedAt = (
  raw: unknown,
  keyId: string,
  actorUri: string,
): RemoteActorKey | undefined => {
  const listed: unknown =
    typeof raw === "object" && raw !== null && "publicKey" in raw ? raw.publicKey : raw;
  const value: unknown = Array.isArray(listed) ? listed[0] : listed;
  const parsed = ServedPublicKeySchema.safeParse(value);
  return parsed.success && parsed.data.id === keyId && parsed.data.owner === actorUri
    ? { kind: "Rsa", keyId, publicKeyPem: parsed.data.publicKeyPem }
    : undefined;
};

/**
 * The actor whose document was served at `keyId`, and the key. A document
 * whose `id` is not `keyId` without its fragment is read again from that
 * `id`, and only that copy counts, as Mastodon's `fetch_resource` with
 * `allow_redirects` takes a document only from its own URL: a document served
 * at some other path of a host cannot speak for an actor there. The key is
 * one the actor's document gives under its URI or a fragment of it; or,
 * for a key id elsewhere on the actor's host (GoToSocial's `/main-key`), the
 * key served at `keyId` itself, when the actor's own document lists it.
 */
const keyFromActorDocument = async (
  identity: InstanceIdentity,
  keyId: string,
  raw: unknown,
  options: KeyResolveOptions,
): Promise<Result<FetchedKey, RemoteActorResolveError>> => {
  const named = DocumentIdSchema.safeParse(raw);
  if (!named.success) {
    return err({ kind: "InvalidSignature" });
  }
  const actorUri = named.data.id;
  let document = raw;
  if (actorUri !== keyId.split("#")[0]) {
    if (Hostname.ofUri(actorUri) !== Hostname.ofUri(keyId)) {
      return err({ kind: "InvalidSignature" });
    }
    const own = await fetchActivityJson(identity, actorUri, options);
    if (own.isErr()) {
      return err(own.error);
    }
    document = own.value;
  }
  const read = remoteActorFromDocument(document, actorUri);
  if (read.isErr()) {
    return err(read.error);
  }
  const given = read.value.keys.find((candidate) => candidate.keyId === keyId);
  if (given !== undefined) {
    return ok({ actor: read.value, key: given });
  }
  const served = publicKeyServedAt(raw, keyId, actorUri);
  if (served === undefined || !listsKey(document, "publicKey", keyId)) {
    return err({ kind: "InvalidSignature" });
  }
  return ok({ actor: { ...read.value, keys: [...read.value.keys, served] }, key: served });
};

/**
 * The owner of a key fetched as its own document, which must list it, as
 * Mastodon's `FetchRemoteKeyService#confirmed_owner?`. The owner is on the
 * key's host.
 */
const keyFromKeyDocument = async (
  identity: InstanceIdentity,
  keyId: string,
  keyDocument: NonNullable<ReturnType<typeof keyDocumentKey>>,
  options: KeyResolveOptions,
): Promise<Result<FetchedKey, RemoteActorResolveError>> => {
  if (
    keyDocument.key.keyId !== keyId ||
    Hostname.ofUri(keyDocument.ownerUri) !== Hostname.ofUri(keyId)
  ) {
    return err({ kind: "InvalidSignature" });
  }
  const ownerDocument = await fetchActivityJson(identity, keyDocument.ownerUri, options);
  if (ownerDocument.isErr()) {
    return err(ownerDocument.error);
  }
  const read = remoteActorFromDocument(ownerDocument.value, keyDocument.ownerUri);
  if (read.isErr()) {
    return err(read.error);
  }
  if (!listsKey(ownerDocument.value, keyDocument.listedIn, keyId)) {
    return err({ kind: "InvalidSignature" });
  }
  // A key the owner names only by its id is the key document's.
  const given = read.value.keys.find((candidate) => candidate.keyId === keyId);
  return ok(
    given
      ? { actor: read.value, key: given }
      : {
          actor: { ...read.value, keys: [...read.value.keys, keyDocument.key] },
          key: keyDocument.key,
        },
  );
};

/**
 * Fetch `keyId` and the actor that owns it, and cache that actor once the key
 * is its own and passes `checkSignature`, as Mastodon's
 * `FetchRemoteKeyService`: the document at `keyId` is the actor's own (see
 * {@link keyFromActorDocument}), or a key document whose owner (`controller`
 * for a Multikey) is fetched and must list it.
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
  const keyDocument = keyDocumentKey(fetched.value);
  const read =
    keyDocument === undefined
      ? await keyFromActorDocument(identity, keyId, fetched.value, options)
      : await keyFromKeyDocument(identity, keyId, keyDocument, options);
  if (read.isErr()) {
    return err(read.error);
  }
  const { actor, key } = read.value;
  // A document speaks only for its own host: one served at a key URL on
  // another host than the actor it describes could rewrite that actor's key.
  if (Hostname.ofUri(actor.actor.actorUri) !== Hostname.ofUri(keyId)) {
    return err({ kind: "InvalidSignature" });
  }
  if (options.checkSignature && !(await options.checkSignature(key))) {
    return err({ kind: "InvalidSignature" });
  }
  const stored = await cacheFetchedActor(db, identity, actor, options);
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
 * Re-fetch a cached actor and run the round trip again. When its document
 * does not answer and its stored handle is on another domain than its URI's,
 * that domain's WebFinger alone decides whether it keeps the handle, so a
 * former holder cannot keep a domain that disowns it by failing its own
 * server altogether.
 */
export const refreshRemoteActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  actorUri: string,
  options: FederatedFetchOptions,
): Promise<Result<void, RepositoryError>> => {
  const fetched = await refetchRemoteActor(db, identity, actorUri, options);
  if (fetched.isOk() || !unreachable(fetched.error)) {
    return fetched.isErr() && fetched.error.kind === "RepositoryError"
      ? err(fetched.error)
      : ok(undefined);
  }
  const stored = await findRemoteActorByUri(db, actorUri);
  if (stored.isErr()) {
    return err(stored.error);
  }
  if (stored.value === undefined || stored.value.webfingeredAt === undefined) {
    return ok(undefined);
  }
  const handle = { username: stored.value.username, domain: stored.value.domain };
  return settleHandleHolder(db, handle, await lookUp(identity, handle, options));
};
