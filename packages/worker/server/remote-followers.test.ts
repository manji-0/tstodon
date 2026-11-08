import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { generateAccountKeys } from "./keys";
import { signInboxRequest } from "./http-signature";
import { upsertRemoteActor } from "./remote-actor-store";
import { RemoteAccountId } from "./remote-account-id";
import { authHeaders } from "../test/auth-fixture";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const Account = z.object({ id: z.string(), username: z.string(), followers_count: z.number() });

/** A remote actor at remote.example whose signed `Follow` reaches `username`'s inbox. */
const followFromRemote = async (name: string, username: string): Promise<string> => {
  const actorUri = `https://remote.example/users/${name}`;
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse("2026-11-01T00:00:00.000Z");
  if (fetchedAt.isErr()) {
    throw new Error("invalid fixture instant");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username: name,
    domain: "remote.example",
    inboxUri: `${actorUri}/inbox`,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: name,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("remote actor fixture rejected");
  }
  expect((await upsertRemoteActor(env.DB, actor.value)).isOk()).toBe(true);
  const body = JSON.stringify({
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${actorUri}/follows/1`,
    type: "Follow",
    actor: actorUri,
    object: `https://example.com/users/${username}`,
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
  const inbox = await json("/inbox", { method: "POST", headers: headers.value, body });
  expect(inbox.status).toBe(202);
  return actorUri;
};

describe("remote followers", () => {
  it("counts and lists a remote follower like a local one", async () => {
    const me = read(
      Account,
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await authHeaders("rfo-target@example.com"),
        })
      ).body,
    );
    const actorUri = await followFromRemote("rfo-follower", me.username);

    const profile = await json(`/api/v1/accounts/${me.id}`);
    expect(read(Account, profile.body).followers_count).toBe(1);

    const followers = await json(`/api/v1/accounts/${me.id}/followers`);
    expect(read(z.array(z.object({ id: z.string() })), followers.body)).toEqual([
      expect.objectContaining({ id: RemoteAccountId.encode(actorUri) }),
    ]);

    const collection = await json(`/users/${me.username}/followers`, {
      headers: { Accept: "application/activity+json" },
    });
    expect(collection.status).toBe(200);
    expect(JSON.stringify(collection.body)).toContain(actorUri);
  });
});
