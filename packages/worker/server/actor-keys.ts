import { Hostname, type RemoteActorKey } from "@tstodon/domain";
import { multibaseKey } from "./multibase";

/** Mastodon's `ProcessAccountService::MAX_PUBLIC_KEYS`: how many of each list it reads. */
const MAX_PUBLIC_KEYS = 10;

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
 * The keys an actor document publishes, as Mastodon's
 * `ProcessAccountService#public_keys` reads them: its FEP-521a
 * `assertionMethod` Multikeys (an `ed25519-pub` or `rsa-pub`
 * `publicKeyMultibase` whose `controller` is the actor), then each
 * `publicKey` whose `owner` is the actor, at most ten of each, the first of a
 * key id kept.
 *
 * Only a key given in the document counts, and its id must be on the actor's
 * host. Mastodon takes one whose id is the actor's URI or a fragment of it as
 * it is given, and fetches any other key id on the actor's host to read the
 * key there; tstodon takes such a key as the document gives it, and does not
 * fetch a key the document names only by its id.
 */
export const actorKeys = (document: unknown, actorUri: string): ReadonlyArray<RemoteActorKey> => {
  const actorHost = Hostname.ofUri(actorUri);
  const onActorHost = (keyId: string): boolean =>
    actorHost !== undefined && Hostname.ofUri(keyId) === actorHost;
  const multikeys = asArray(member(document, "assertionMethod"))
    .slice(0, MAX_PUBLIC_KEYS)
    .flatMap((value): ReadonlyArray<RemoteActorKey> => {
      const keyId = text(value, "id");
      const multibase = text(value, "publicKeyMultibase");
      if (
        member(value, "type") !== "Multikey" ||
        member(value, "controller") !== actorUri ||
        keyId === undefined ||
        multibase === undefined ||
        !onActorHost(keyId)
      ) {
        return [];
      }
      const key = multibaseKey(multibase);
      return key === undefined ? [] : [{ ...key, keyId }];
    });
  const publicKeys = asArray(member(document, "publicKey"))
    .slice(0, MAX_PUBLIC_KEYS)
    .flatMap((value): ReadonlyArray<RemoteActorKey> => {
      const keyId = text(value, "id");
      const publicKeyPem = text(value, "publicKeyPem");
      return member(value, "owner") === actorUri &&
        keyId !== undefined &&
        publicKeyPem !== undefined &&
        onActorHost(keyId)
        ? [{ kind: "Rsa", keyId, publicKeyPem }]
        : [];
    });
  const seen = new Set<string>();
  return [...multikeys, ...publicKeys].filter((key) => {
    if (seen.has(key.keyId)) {
      return false;
    }
    seen.add(key.keyId);
    return true;
  });
};
