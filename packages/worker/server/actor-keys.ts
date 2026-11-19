import type { RemoteActorKey } from "@tstodon/domain";
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
 * Only a key the document gives in full, under the actor's URI or a
 * fragment of it, counts: Mastodon takes such a key as it is given. Mastodon
 * fetches any other key id (GoToSocial's `/main-key`) to read the key at its
 * own URL; tstodon reads such a key only when a signature names it
 * (`fetchKeyOwner`), so a document cannot claim a key id another actor on its
 * host owns.
 */
export const actorKeys = (document: unknown, actorUri: string): ReadonlyArray<RemoteActorKey> => {
  const ownKeyId = (keyId: string): boolean => keyId.split("#")[0] === actorUri;
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
        !ownKeyId(keyId)
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
        ownKeyId(keyId)
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
