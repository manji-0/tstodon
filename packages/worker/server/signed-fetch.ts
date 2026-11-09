import { Hostname, type InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { suspendedDomains } from "./admin-domain-block-store";
import { parseSignatureHeader, verifySignedFetch } from "./http-signature";
import { resolveRemoteActor } from "./remote-actor-fetch";
import { getRemoteActorModeration } from "./remote-actor-moderation-store";
import { findRemoteActorByPublicKeyId } from "./remote-actor-store";
import { allowListAdmits, federationAllowHosts } from "./runtime-config";
import { instanceActorFetchSigner } from "./instance-actor";

/** What the `Signature` of a GET says about who asks (an "authorized fetch"). */
export type SignedFetchVerdict =
  /** No `Signature` header, or one that does not parse. */
  | Readonly<{ kind: "Unsigned" }>
  /** The key could not be used, or the signature does not verify. */
  | Readonly<{ kind: "Invalid" }>
  /** The key's server did not answer, or D1 could not be read. */
  | Readonly<{ kind: "Unavailable" }>
  /** The signer's domain is suspended or not allowed, or an admin suspended the signer. */
  | Readonly<{ kind: "Refused" }>
  | Readonly<{ kind: "Signed"; actor: RemoteActor }>;

const verdicts = new WeakMap<Request, Promise<SignedFetchVerdict>>();

const verify = async (
  env: Env,
  identity: InstanceIdentity,
  request: Request,
): Promise<SignedFetchVerdict> => {
  const header = request.headers.get("Signature");
  const parsed = header ? parseSignatureHeader(header) : undefined;
  if (!parsed) {
    return { kind: "Unsigned" };
  }
  // A signed GET names no actor; the key's cached owner, or the key URL
  // without its fragment, is the actor to resolve.
  const cached = await findRemoteActorByPublicKeyId(env.DB, parsed.keyId);
  const actorUri =
    (cached.isOk() ? cached.value?.actorUri : undefined) ?? parsed.keyId.split("#")[0] ?? "";
  const [allowHosts, suspended] = await Promise.all([
    federationAllowHosts(env),
    suspendedDomains(env.DB),
  ]);
  const refusedHost = (host: Hostname): boolean =>
    suspended.has(host) || !allowListAdmits(allowHosts, host);
  // A key on a suspended or not-allowed host is refused before it is fetched.
  const keyHost = Hostname.ofUri(parsed.keyId);
  if (keyHost !== undefined && refusedHost(keyHost)) {
    return { kind: "Refused" };
  }
  const actor = await resolveRemoteActor(env.DB, identity, parsed.keyId, actorUri, {
    allowHosts,
    blockedHosts: suspended,
    fetchSigner: instanceActorFetchSigner(env.DB, identity),
    checkSignature: (publicKeyPem) => verifySignedFetch(request, parsed, publicKeyPem),
  });
  if (actor.isErr()) {
    switch (actor.error.kind) {
      case "VerificationUnavailable":
      case "RepositoryError":
        return { kind: "Unavailable" };
      case "DomainRefused":
        return { kind: "Refused" };
      case "InvalidSignature":
        return { kind: "Invalid" };
    }
  }
  if (RemoteActor.hostnames(actor.value).some(refusedHost)) {
    return { kind: "Refused" };
  }
  if (!(await verifySignedFetch(request, parsed, actor.value.publicKeyPem))) {
    return { kind: "Invalid" };
  }
  const moderation = await getRemoteActorModeration(env.DB, actor.value.actorUri);
  if (moderation.isErr()) {
    return { kind: "Unavailable" };
  }
  return moderation.value.standing.kind === "Suspended"
    ? { kind: "Refused" }
    : { kind: "Signed", actor: actor.value };
};

/**
 * Who signed this GET, verified once per request: the authorized-fetch check
 * and the route itself share the answer.
 */
export const signedFetchVerdict = (
  env: Env,
  identity: InstanceIdentity,
  request: Request,
): Promise<SignedFetchVerdict> => {
  const known = verdicts.get(request);
  if (known !== undefined) {
    return known;
  }
  const verdict = verify(env, identity, request);
  verdicts.set(request, verdict);
  return verdict;
};

/**
 * The remote actor that signed this GET (an "authorized fetch"), or undefined
 * when it is unsigned, the key cannot be resolved, the signature does not
 * verify, the actor's domain does not federate here, or an admin suspended it.
 */
export const signedFetchActor = async (
  env: Env,
  identity: InstanceIdentity,
  request: Request,
): Promise<RemoteActor | undefined> => {
  const verdict = await signedFetchVerdict(env, identity, request);
  return verdict.kind === "Signed" ? verdict.actor : undefined;
};
