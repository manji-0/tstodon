import { SELF, env } from "cloudflare:test";
import { expect } from "vite-plus/test";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { signFetchRequest, signInboxRequest } from "../src/http-signature";
import { generateAccountKeys } from "../src/keys";
import { upsertRemoteActor } from "../src/remote-actor-store";

export type Remote = Readonly<{
  actorUri: string;
  publicKeyPem: string;
  send: (activity: Record<string, unknown>) => Promise<number>;
  /** A GET signed with this actor's key (authorized fetch). */
  fetch: (path: string) => Promise<Response>;
}>;

/**
 * A cached remote actor that can sign inbox deliveries. Its URI is on
 * `host`; its account domain is `options.accountDomain`, `host` by default,
 * as a WebFinger domain that serves actors from another host. With
 * `cache: false` it is not stored, so the first delivery fetches its document.
 * `fetchedAt` is when it was cached, 2026-10-01 by default.
 */
export const remoteActor = async (
  username: string,
  host: string = "remote.example",
  options: Readonly<{
    sharedInboxUri?: string;
    accountDomain?: string;
    cache?: false;
    fetchedAt?: string;
  }> = {},
): Promise<Remote> => {
  const actorUri = `https://${host}/users/${username}`;
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse(options.fetchedAt ?? "2026-10-01T00:00:00.000Z");
  if (fetchedAt.isErr()) {
    throw new Error("invalid fixture instant");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username,
    domain: options.accountDomain ?? host,
    inboxUri: `${actorUri}/inbox`,
    sharedInboxUri: options.sharedInboxUri,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: `Remote ${username}`,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("remote actor fixture rejected");
  }
  if (options.cache !== false) {
    expect((await upsertRemoteActor(env.DB, actor.value)).isOk()).toBe(true);
  }
  return {
    actorUri,
    publicKeyPem: keys.publicKeyPem,
    fetch: async (path) => {
      const url = new URL(path, "https://example.com");
      const headers = await signFetchRequest(url, keys.privateKeyJwk, `${actorUri}#main-key`);
      if (headers.isErr()) {
        throw new Error(headers.error.message);
      }
      return SELF.fetch(url, { headers: headers.value });
    },
    send: async (activity) => {
      const body = JSON.stringify({
        "@context": "https://www.w3.org/ns/activitystreams",
        actor: actorUri,
        ...activity,
      });
      const headers = await signInboxRequest(
        new URL("https://example.com/inbox"),
        keys.privateKeyJwk,
        `${actorUri}#main-key`,
        body,
      );
      if (headers.isErr()) {
        throw new Error(headers.error.message);
      }
      return (
        await SELF.fetch("https://example.com/inbox", {
          method: "POST",
          headers: headers.value,
          body,
        })
      ).status;
    },
  };
};
