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
import { type RepositoryError, toRepositoryError } from "./d1";
import {
  fetchActivityJson,
  type FederatedFetchError,
  fetchWebfinger,
  type FederatedFetchOptions,
  isFederatedHostRefused,
} from "./federated-fetch";
import { ActorDocumentSchema } from "./activitypub-wire";
import {
  claimRemoteActorRefresh,
  findRemoteActorByHandle,
  findRemoteActorByPublicKeyId,
  findRemoteActorByUri,
  releaseRemoteActorHandle,
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

/**
 * A WebFinger lookup: the account its `subject` names and its `self` link;
 * `Disowned` when the server answered 404 or 410; `Failed` when nothing is
 * known (a timeout, a 5xx, a redirect it does not follow, any other 4xx, an
 * unreadable answer, no `self` link).
 */
type WebfingerLookup =
  | Readonly<{ kind: "Answered"; subject: AccountHandle | undefined; self: string }>
  | Readonly<{ kind: "Disowned" }>
  | Readonly<{ kind: "Failed"; error: FederatedFetchError }>;

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
  return { kind: "Answered", subject: domainHandle(answer.value.subject), self: answer.value.self };
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
 * Cache an actor read from its own document, under the handle the round trip
 * settles (`WebfingerConfirmation.handleWrite`). A confirmed handle is taken
 * from any other row that held it. An actor whose claimed account domain is
 * refused is not cached.
 */
export const cacheFetchedActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  actor: RemoteActor,
  options: FederatedFetchOptions,
  check: HandleCheck = { kind: "RoundTrip" },
): Promise<Result<RemoteActor, CacheFetchedActorError>> => {
  const now = IsoInstant.parse(nowIso());
  if (now.isErr()) {
    return err(toRepositoryError("invalid clock"));
  }
  const { webfingeredAt: _fromCaller, ...document } = actor;
  if (check.kind === "KeepStored") {
    return upsertRemoteActorKeepingHandle(db, document);
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
  const write = WebfingerConfirmation.handleWrite(confirmation, now.value);
  if (write.isErr()) {
    return err(write.error);
  }
  switch (write.value.kind) {
    case "Confirm":
      return upsertConfirmedRemoteActor(db, {
        ...document,
        ...write.value.handle,
        webfingeredAt: write.value.webfingeredAt,
      });
    case "UriAuthority":
      return upsertRemoteActor(db, document);
    case "Keep":
      return upsertRemoteActorKeepingHandle(db, document);
  }
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
  return cacheFetchedActor(db, identity, actor.value, options);
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
  const actor = remoteActorFromDocument(fetched.value, actorUri);
  if (actor.isErr()) {
    return err(actor.error);
  }
  return cacheFetchedActor(db, identity, actor.value, options, check);
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
  options: HandleResolveOptions = {},
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
