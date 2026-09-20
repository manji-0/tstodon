import { IsoInstant, RemoteActor, type InstanceIdentity } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { ActorDocumentSchema } from "./schemas";
import {
  findRemoteActorByPublicKeyId,
  findRemoteActorByUri,
  upsertRemoteActor,
} from "./remote-actor-store";

export type RemoteActorResolveError =
  | Readonly<{ kind: "InvalidSignature" }>
  | Readonly<{ kind: "VerificationUnavailable" }>
  | RepositoryError;

const blockedHost = (hostname: string, instanceDomain: string): boolean => {
  const host = hostname.toLowerCase();
  if (host === instanceDomain) {
    return true;
  }
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  ) {
    return true;
  }
  if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) {
    return true;
  }
  const octets = host.split(".");
  if (octets.length === 4 && octets[0] === "172") {
    const second = Number.parseInt(octets[1] ?? "", 10);
    if (second >= 16 && second <= 31) {
      return true;
    }
  }
  return false;
};

const documentUrlFromKeyId = (keyId: string): Result<URL, RemoteActorResolveError> => {
  try {
    const url = new URL(keyId);
    url.hash = "";
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return err({ kind: "InvalidSignature" });
    }
    return ok(url);
  } catch {
    return err({ kind: "InvalidSignature" });
  }
};

const remoteActorFromDocument = (
  raw: unknown,
  keyId: string,
  actorUri: string,
): Result<RemoteActor, RemoteActorResolveError> => {
  const document = schemaResult(ActorDocumentSchema)(raw);
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

const fetchRemoteActorDocument = async (
  identity: InstanceIdentity,
  keyId: string,
  actorUri: string,
): Promise<Result<RemoteActor, RemoteActorResolveError>> => {
  const url = documentUrlFromKeyId(keyId);
  if (url.isErr()) {
    return err(url.error);
  }
  if (blockedHost(url.value.hostname, identity.domain)) {
    return err({ kind: "InvalidSignature" });
  }
  try {
    const response = await fetch(url.value, {
      method: "GET",
      headers: {
        Accept:
          'application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
        "User-Agent": `tstodon (https://${identity.domain})`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status >= 500) {
      return err({ kind: "VerificationUnavailable" });
    }
    if (!response.ok) {
      return err({ kind: "InvalidSignature" });
    }
    return remoteActorFromDocument(await response.json(), keyId, actorUri);
  } catch {
    return err({ kind: "VerificationUnavailable" });
  }
};

export const resolveRemoteActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  keyId: string,
  actorUri: string,
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
  const fetched = await fetchRemoteActorDocument(identity, keyId, actorUri);
  if (fetched.isErr()) {
    return err(fetched.error);
  }
  const stored = await upsertRemoteActor(db, fetched.value);
  if (stored.isErr()) {
    return err(stored.error);
  }
  return ok(stored.value);
};
