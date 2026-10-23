import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { upsertRemoteActor } from "./remote-actor-store";
import { upsertRemoteAnnounce, upsertRemoteFavourite } from "./remote-interaction-store";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

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
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const AccountListSchema = z.array(
  z.object({ id: z.string().min(1), username: z.string().min(1), acct: z.string().min(1) }),
);

const postStatus = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const engage = async (email: string, statusId: string, action: "favourite" | "reblog") => {
  const response = await json(`/api/v1/statuses/${statusId}/${action}`, {
    method: "POST",
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
};

const remoteActorFixture = async (
  actorUri: string,
  username: string,
  domain: string,
): Promise<RemoteActor> => {
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    throw new Error("clock");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username,
    domain,
    inboxUri: `${actorUri}/inbox`,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: username,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("actor fixture rejected");
  }
  const stored = await upsertRemoteActor(env.DB, actor.value);
  expect(stored.isOk()).toBe(true);
  return actor.value;
};

describe("status engagement accounts", () => {
  it("lists who favourited a status, local and remote", async () => {
    const author = "engagement-author@example.com";
    const fan = "engagement-fan@example.com";
    const statusId = await postStatus(author, { status: "engagement please" });
    await engage(fan, statusId, "favourite");

    const actorUri = "https://engagement.example/users/kat";
    await remoteActorFixture(actorUri, "kat", "engagement.example");
    const liked = await upsertRemoteFavourite(env.DB, actorUri, statusId);
    expect(liked.isOk()).toBe(true);

    const listed = await json(`/api/v1/statuses/${statusId}/favourited_by`);
    expect(listed.status).toBe(200);
    const accounts = read(AccountListSchema, listed.body);
    expect(accounts.map((account) => account.acct)).toEqual(
      expect.arrayContaining(["engagement_fan", "kat@engagement.example"]),
    );

    // The remote half is absent from `reblogged_by`.
    const boosted = await json(`/api/v1/statuses/${statusId}/reblogged_by`);
    expect(read(AccountListSchema, boosted.body)).toEqual([]);
  });

  it("lists who boosted a status, local and remote, newest first", async () => {
    const author = "boost-author@example.com";
    const first = "boost-first@example.com";
    const second = "boost-second@example.com";
    const statusId = await postStatus(author, { status: "boost me" });
    await engage(first, statusId, "reblog");
    await engage(second, statusId, "reblog");

    const actorUri = "https://boost.example/users/lee";
    await remoteActorFixture(actorUri, "lee", "boost.example");
    const announced = await upsertRemoteAnnounce(env.DB, actorUri, statusId, "https://act/1");
    expect(announced.isOk()).toBe(true);

    const listed = await json(`/api/v1/statuses/${statusId}/reblogged_by`);
    const accounts = read(AccountListSchema, listed.body);
    expect(accounts).toHaveLength(3);

    // Mastodon caps account collections at 80 and defaults to 40.
    const capped = await json(`/api/v1/statuses/${statusId}/reblogged_by?limit=1`);
    expect(read(AccountListSchema, capped.body).map((account) => account.id)).toEqual([
      accounts[0]?.id,
    ]);
  });

  it("hides the list for a status the requester cannot see", async () => {
    const author = "engagement-private@example.com";
    const mentioned = "engagement-mentioned@example.com";
    const statusId = await postStatus(author, {
      status: `@${mentioned} a secret`,
      visibility: "direct",
    });

    // Anonymous readers and unrelated accounts get Mastodon's 404.
    const anonymous = await json(`/api/v1/statuses/${statusId}/favourited_by`);
    expect(anonymous.status).toBe(404);
    const stranger = await json(`/api/v1/statuses/${statusId}/reblogged_by`, {
      headers: await auth("engagement-stranger@example.com"),
    });
    expect(stranger.status).toBe(404);
    // The author still sees it.
    const own = await json(`/api/v1/statuses/${statusId}/favourited_by`, {
      headers: await auth(author),
    });
    expect(own.status).toBe(200);
    expect(read(AccountListSchema, own.body)).toEqual([]);
  });

  it("answers 404 for an unknown status", async () => {
    const missing = await json("/api/v1/statuses/does-not-exist/favourited_by");
    expect(missing.status).toBe(404);
    expect(read(z.object({ error: z.string() }), missing.body).error).toBe("Record not found");
  });
});
