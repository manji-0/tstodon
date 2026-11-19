import { SELF, env } from "cloudflare:test";
import { expect } from "vite-plus/test";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { signFetchRequest, signInboxRequest } from "../server/http-signature";
import { generateAccountKeys } from "../server/keys";
import { signLdDocument } from "../server/ld-signature";
import { upsertRemoteActor } from "../server/remote-actor-store";

export type Remote = Readonly<{
  actorUri: string;
  publicKeyPem: string;
  send: (activity: Record<string, unknown>) => Promise<number>;
  /** The signed shared-inbox delivery `send` posts, unsent; signed at `date`, now by default. */
  delivery: (activity: Record<string, unknown>, date?: Date) => Promise<Request>;
  /**
   * `activity` as `delivery` sends it, with this actor's Linked Data
   * signature (`RsaSignature2017`) made at `date`, now by default.
   */
  ldSigned: (activity: Record<string, unknown>, date?: Date) => Promise<Record<string, unknown>>;
  /**
   * A shared-inbox delivery of `body` exactly as given, signed with this
   * actor's key: how a server forwards another actor's activity.
   */
  forward: (body: Record<string, unknown>, date?: Date) => Promise<Request>;
  /** A GET signed with this actor's key (authorized fetch). */
  fetch: (path: string) => Promise<Response>;
  /** The signed GET `fetch` sends, unsent; signed at `date`, now by default. */
  signedGet: (path: string, date?: Date) => Promise<Request>;
}>;

/**
 * A cached remote actor that can sign inbox deliveries. Its URI is on
 * `host`; its account domain is `options.accountDomain`, `host` by default,
 * as a WebFinger domain that serves actors from another host. With
 * `cache: false` it is not stored, so the first delivery fetches its document.
 * `fetchedAt` is when it was cached, now by default. An account domain other
 * than `host` is stamped as confirmed by WebFinger then, as only a confirmation
 * stores one. `published` is the actor document's `published` date, none by
 * default. `path` is the actor URI's path, `/users/<username>` by default, for
 * software that serves its actors elsewhere (PeerTube's `/accounts/<name>`).
 */
export const remoteActor = async (
  username: string,
  host: string = "remote.example",
  options: Readonly<{
    sharedInboxUri?: string;
    accountDomain?: string;
    cache?: false;
    fetchedAt?: string;
    followersUri?: string;
    followingUri?: string;
    featuredUri?: string;
    published?: string;
    path?: string;
    /** The actor's `url`: its profile page. */
    profileUrl?: string;
  }> = {},
): Promise<Remote> => {
  const actorUri = `https://${host}${options.path ?? `/users/${username}`}`;
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse(options.fetchedAt ?? new Date().toISOString());
  const published =
    options.published === undefined ? undefined : IsoInstant.parse(options.published);
  if (fetchedAt.isErr() || published?.isErr()) {
    throw new Error("invalid fixture instant");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username,
    domain: options.accountDomain ?? host,
    inboxUri: `${actorUri}/inbox`,
    sharedInboxUri: options.sharedInboxUri,
    followersUri: options.followersUri,
    followingUri: options.followingUri,
    featuredUri: options.featuredUri,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: `Remote ${username}`,
    profile: {
      ...RemoteActor.emptyProfile,
      publishedAt: published?.unwrapOr(null) ?? null,
      profileUrl: options.profileUrl ?? null,
    },
    fetchedAt: fetchedAt.value,
    webfingeredAt:
      options.accountDomain === undefined || options.accountDomain === host
        ? undefined
        : fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("remote actor fixture rejected");
  }
  if (options.cache !== false) {
    expect((await upsertRemoteActor(env.DB, actor.value)).isOk()).toBe(true);
  }
  const asDelivered = (activity: Record<string, unknown>): Record<string, unknown> => ({
    "@context": "https://www.w3.org/ns/activitystreams",
    actor: actorUri,
    ...activity,
  });
  const forward = async (
    document: Record<string, unknown>,
    date: Date = new Date(),
  ): Promise<Request> => {
    const body = JSON.stringify(document);
    const headers = await signInboxRequest(
      new URL("https://example.com/inbox"),
      keys.privateKeyJwk,
      `${actorUri}#main-key`,
      body,
      date,
    );
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    return new Request("https://example.com/inbox", {
      method: "POST",
      headers: headers.value,
      body,
    });
  };
  const delivery = (activity: Record<string, unknown>, date?: Date): Promise<Request> =>
    forward(asDelivered(activity), date);
  const ldSigned = async (
    activity: Record<string, unknown>,
    date: Date = new Date(),
  ): Promise<Record<string, unknown>> => {
    const signed = await signLdDocument(
      asDelivered(activity),
      { keyId: `${actorUri}#main-key`, privateKeyJwk: keys.privateKeyJwk },
      date,
    );
    if (signed.isErr()) {
      throw new Error(`LD signature failed: ${signed.error.kind}`);
    }
    return signed.value;
  };
  const signedGet = async (path: string, date: Date = new Date()): Promise<Request> => {
    const url = new URL(path, "https://example.com");
    const accept = "application/activity+json";
    const headers = await signFetchRequest(
      url,
      keys.privateKeyJwk,
      `${actorUri}#main-key`,
      accept,
      date,
    );
    if (headers.isErr()) {
      throw new Error(headers.error.message);
    }
    return new Request(url, { headers: { ...headers.value, Host: url.host, Accept: accept } });
  };
  return {
    actorUri,
    publicKeyPem: keys.publicKeyPem,
    fetch: async (path) => SELF.fetch(await signedGet(path)),
    signedGet,
    delivery,
    ldSigned,
    forward,
    send: async (activity) => (await SELF.fetch(await delivery(activity))).status,
  };
};
