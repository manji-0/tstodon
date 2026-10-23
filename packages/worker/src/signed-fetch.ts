import type { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { suspendedDomains } from "./admin-domain-block-store";
import { parseSignatureHeader, verifySignedFetch } from "./http-signature";
import { resolveRemoteActor } from "./remote-actor-fetch";
import { findRemoteActorByPublicKeyId } from "./remote-actor-store";
import { allowListAdmits, federationAllowHosts } from "./runtime-config";

/**
 * The remote actor that signed this GET (an "authorized fetch"), or undefined
 * when it is unsigned, the key cannot be resolved, the signature does not
 * verify, or the actor's domain does not federate here.
 */
export const signedFetchActor = async (
  env: Env,
  identity: InstanceIdentity,
  request: Request,
): Promise<RemoteActor | undefined> => {
  const header = request.headers.get("Signature");
  const parsed = header ? parseSignatureHeader(header) : undefined;
  if (!parsed) {
    return undefined;
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
  const actor = await resolveRemoteActor(env.DB, identity, parsed.keyId, actorUri, {
    allowHosts,
    blockedHosts: suspended,
  });
  if (actor.isErr()) {
    return undefined;
  }
  const host = actor.value.domain.toLowerCase();
  if (suspended.has(host) || !allowListAdmits(allowHosts, host)) {
    return undefined;
  }
  return (await verifySignedFetch(request, parsed, actor.value.publicKeyPem))
    ? actor.value
    : undefined;
};
