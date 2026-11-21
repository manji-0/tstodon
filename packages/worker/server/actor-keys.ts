import type { InstanceIdentity, RemoteActorKey } from "@tstodon/domain";
import { err, ok, Result } from "neverthrow";
import {
  fetchActivityJson,
  type FederatedFetchError,
  type FederatedFetchOptions,
} from "./federated-fetch";
import { multibaseKey } from "./multibase";

/** Mastodon's `ProcessAccountService::MAX_PUBLIC_KEYS`: how many of each list it reads. */
const MAX_PUBLIC_KEYS = 10;

/**
 * A key an actor document publishes: given in full under the actor's URI or
 * a fragment of it (`Given`), or named by an id elsewhere on the actor's host
 * (`Named`), whose own document holds the key. `form` is the list that named
 * it: a `publicKey` or a FEP-521a `assertionMethod` Multikey.
 */
export type PublishedKey =
  | Readonly<{ kind: "Given"; key: RemoteActorKey }>
  | Readonly<{ kind: "Named"; keyId: string; form: KeyForm }>;

type KeyForm = "PublicKey" | "Multikey";

/** A `publicKeyMultibase` that is not of its base: Mastodon refuses the whole actor. */
export type MalformedMultibase = Readonly<{ kind: "MalformedMultibase" }>;

const asArray = (value: unknown): ReadonlyArray<unknown> =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const member = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Reflect.get(value, name)
    : undefined;

const text = (value: unknown, name: string): string | undefined => {
  const read = member(value, name);
  return typeof read === "string" && read.length > 0 ? read : undefined;
};

/**
 * A key named by `keyId`, read from its own document, when `keyId` is an
 * http(s) URL on the actor's host, the port aside: Mastodon's
 * `non_matching_uri_hosts?` skips any other before it is fetched.
 */
const named = (keyId: string, actorUri: string, form: KeyForm): PublishedKey | undefined => {
  const key = URL.parse(keyId);
  return key !== null &&
    (key.protocol === "https:" || key.protocol === "http:") &&
    key.hostname === URL.parse(actorUri)?.hostname
    ? { kind: "Named", keyId, form }
    : undefined;
};

/** Whether `keyId` is the actor's URI or a fragment of it, as Mastodon's `split('#').first` compares. */
const underActor = (keyId: string, actorUri: string): boolean => keyId.split("#")[0] === actorUri;

const multikey = (
  value: unknown,
  actorUri: string,
): Result<PublishedKey | undefined, MalformedMultibase> => {
  if (typeof value === "string") {
    return ok(named(value, actorUri, "Multikey"));
  }
  if (member(value, "type") !== "Multikey" || member(value, "controller") !== actorUri) {
    return ok(undefined);
  }
  const multibase = member(value, "publicKeyMultibase");
  const read = typeof multibase === "string" ? multibaseKey(multibase) : undefined;
  if (read?.kind === "Malformed") {
    return err({ kind: "MalformedMultibase" });
  }
  const keyId = text(value, "id");
  if (read?.kind !== "Key" || keyId === undefined) {
    return ok(undefined);
  }
  return ok(
    underActor(keyId, actorUri)
      ? { kind: "Given", key: { ...read.key, keyId } }
      : named(keyId, actorUri, "Multikey"),
  );
};

const publicKey = (value: unknown, actorUri: string): PublishedKey | undefined => {
  if (typeof value === "string") {
    return named(value, actorUri, "PublicKey");
  }
  const keyId = text(value, "id");
  if (member(value, "owner") !== actorUri || keyId === undefined) {
    return undefined;
  }
  if (!underActor(keyId, actorUri)) {
    return named(keyId, actorUri, "PublicKey");
  }
  const publicKeyPem = text(value, "publicKeyPem");
  return publicKeyPem === undefined
    ? undefined
    : { kind: "Given", key: { kind: "Rsa", keyId, publicKeyPem } };
};

/**
 * The keys an actor document publishes, as Mastodon's
 * `ProcessAccountService#public_keys` reads them: its FEP-521a
 * `assertionMethod` Multikeys (an `ed25519-pub` or `rsa-pub`
 * `publicKeyMultibase`), then its `publicKey`s, at most ten of each. An
 * object counts only when its `controller` (`owner` for a `publicKey`) is the
 * actor; one whose id is the actor's URI or a fragment of it is taken as
 * given, and any other id, or an id alone, names a key to read from its own
 * document ({@link resolvePublishedKeys}), only on the actor's host. A
 * Multikey of the actor whose `publicKeyMultibase` is not of its base refuses
 * the whole document, as the `ArgumentError` it raises in Mastodon does.
 */
export const publishedKeys = (
  document: unknown,
  actorUri: string,
): Result<ReadonlyArray<PublishedKey>, MalformedMultibase> => {
  const multikeys = Result.combine(
    asArray(member(document, "assertionMethod"))
      .slice(0, MAX_PUBLIC_KEYS)
      .map((value) => multikey(value, actorUri)),
  );
  const publicKeys = asArray(member(document, "publicKey"))
    .slice(0, MAX_PUBLIC_KEYS)
    .map((value) => publicKey(value, actorUri));
  return multikeys.map((read) => [...read, ...publicKeys].filter((key) => key !== undefined));
};

/**
 * The `publicKey` served at a key id for `actorUri`: the document itself, or
 * the first of its `publicKey` (GoToSocial serves its actor at `/main-key`),
 * as `legacy_public_keys` reads it after `fetch_resource_without_id_validation`:
 * its `owner` must be the actor, and its own `id` is not read.
 */
const servedPublicKey = (
  raw: unknown,
  keyId: string,
  actorUri: string,
): RemoteActorKey | undefined => {
  const listed = member(raw, "publicKey");
  const value: unknown =
    typeof raw === "object" && raw !== null && "publicKey" in raw
      ? Array.isArray(listed)
        ? listed[0]
        : listed
      : raw;
  const publicKeyPem = text(value, "publicKeyPem");
  return member(value, "owner") === actorUri && publicKeyPem !== undefined
    ? { kind: "Rsa", keyId, publicKeyPem }
    : undefined;
};

/**
 * The Multikey served at a key id for `actorUri`, as `fep_521a_public_keys`
 * reads it after `fetch_resource`: a `Multikey` whose `id` is the key id and
 * whose `controller` is the actor.
 */
const servedMultikey = (
  raw: unknown,
  keyId: string,
  actorUri: string,
): Result<RemoteActorKey | undefined, MalformedMultibase> => {
  if (
    member(raw, "id") !== keyId ||
    member(raw, "type") !== "Multikey" ||
    member(raw, "controller") !== actorUri
  ) {
    return ok(undefined);
  }
  const multibase = member(raw, "publicKeyMultibase");
  const read = typeof multibase === "string" ? multibaseKey(multibase) : undefined;
  if (read?.kind === "Malformed") {
    return err({ kind: "MalformedMultibase" });
  }
  return ok(read?.kind === "Key" ? { ...read.key, keyId } : undefined);
};

/**
 * Whether a fetch failed before any answer came: Mastodon's HTTP client
 * raises then (a timeout, a refused connection), which stops the whole
 * actor update, where any answer but a document only skips the key.
 */
const noAnswer = (error: FederatedFetchError): boolean =>
  error.kind === "VerificationUnavailable" && error.status === undefined;

/**
 * How many keys are fetched at once. A Worker opens six connections at a
 * time and queues the rest, while each fetch's deadline already runs, so a
 * queued fetch could time out and read as no answer.
 */
const MAX_CONCURRENT_FETCHES = 6;

/** `run` over `items`, at most `limit` at a time, the results in order. */
const mapPooled = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        results[index] = await run(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/**
 * The keys `published` (from {@link publishedKeys}) stand for: each given
 * key, and each named one read from its own document, fetched unless
 * `fetched` holds it (the document a signature's key id already served),
 * the first of a key id kept. A named key whose document is not a key of the
 * actor is skipped, so a refetch drops it, as Mastodon's
 * `set_fetchable_key!` deletes the keys `public_keys` does not return. A
 * fetch with no answer fails the whole read (`VerificationUnavailable`), so
 * the caller keeps what it holds; a malformed `publicKeyMultibase` refuses
 * the actor (`InvalidSignature`). At most twenty keys are fetched, ten from
 * each list, six at a time.
 */
export const resolvePublishedKeys = async (
  identity: InstanceIdentity,
  actorUri: string,
  published: ReadonlyArray<PublishedKey>,
  options: FederatedFetchOptions,
  fetched: ReadonlyMap<string, unknown> = new Map(),
): Promise<Result<ReadonlyArray<RemoteActorKey>, FederatedFetchError>> => {
  const read = await mapPooled(
    published,
    MAX_CONCURRENT_FETCHES,
    async (entry): Promise<Result<RemoteActorKey | undefined, FederatedFetchError>> => {
      if (entry.kind === "Given") {
        return ok(entry.key);
      }
      const document = fetched.has(entry.keyId)
        ? ok(fetched.get(entry.keyId))
        : await fetchActivityJson(identity, entry.keyId, options);
      if (document.isErr()) {
        return noAnswer(document.error) ? err({ kind: "VerificationUnavailable" }) : ok(undefined);
      }
      if (entry.form === "PublicKey") {
        return ok(servedPublicKey(document.value, entry.keyId, actorUri));
      }
      return servedMultikey(document.value, entry.keyId, actorUri).mapErr(
        (): FederatedFetchError => ({ kind: "InvalidSignature" }),
      );
    },
  );
  const seen = new Set<string>();
  return Result.combine(read).map((keys) =>
    keys.filter((key): key is RemoteActorKey => {
      if (key === undefined || seen.has(key.keyId)) {
        return false;
      }
      seen.add(key.keyId);
      return true;
    }),
  );
};
