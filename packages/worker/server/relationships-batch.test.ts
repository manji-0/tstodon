import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount, ApiRelationship } from "@tstodon/api";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const accountIdFor = async (email: string): Promise<string> =>
  read(
    ApiAccount,
    (await json("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })).body,
  ).id;

const post = async (email: string, path: string, body: unknown = {}): Promise<void> => {
  const response = await json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};

const relationships = async (email: string, ids: ReadonlyArray<string>) => {
  const query = ids.map((id) => `id[]=${encodeURIComponent(id)}`).join("&");
  const response = await json(`/api/v1/accounts/relationships?${query}`, {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(z.array(ApiRelationship), response.body);
};

describe("GET /api/v1/accounts/relationships with many ids", () => {
  it("answers each requested id in order, duplicates and unknown ids included, as one id at a time", async () => {
    const viewer = "rel-batch-viewer@example.com";
    await accountIdFor(viewer);
    const followed = await accountIdFor("rel-batch-followed@example.com");
    const blocked = await accountIdFor("rel-batch-blocked@example.com");
    const muted = await accountIdFor("rel-batch-muted@example.com");
    const follower = "rel-batch-follower@example.com";
    const followerId = await accountIdFor(follower);
    const remote = RemoteAccountId.encode(
      (await remoteActor("rel-batch-remote", "batch.example")).actorUri,
    );
    const unknownRemote = RemoteAccountId.encode("https://nowhere.example/users/ghost");

    await post(viewer, `/api/v1/accounts/${followed}/follow`);
    await post(viewer, `/api/v1/accounts/${followed}/endorse`);
    await post(viewer, `/api/v1/accounts/${blocked}/block`);
    await post(viewer, `/api/v1/accounts/${muted}/mute`, { notifications: false });
    await post(follower, `/api/v1/accounts/${await accountIdFor(viewer)}/follow`);
    await post(viewer, `/api/v1/accounts/${remote}/note`, { comment: "far away" });
    await post(viewer, `/api/v1/accounts/${followed}/note`, { comment: "close by" });

    const known = [followed, blocked, muted, followerId, remote, unknownRemote, "no-such-account"];
    const ids = [
      ...known,
      ...Array.from({ length: 110 }, (_, index) => `rel-batch-missing-${index}`),
      followed,
      remote,
      blocked,
    ];
    const batch = await relationships(viewer, ids);

    expect(batch.map((relationship) => relationship.id)).toEqual(ids);
    for (const id of known) {
      const [single] = await relationships(viewer, [id]);
      for (const entry of batch.filter((relationship) => relationship.id === id)) {
        expect(entry).toEqual(single);
      }
    }
    const byId = new Map(batch.map((relationship) => [relationship.id, relationship]));
    expect(byId.get(followed)).toMatchObject({
      following: true,
      endorsed: true,
      note: "close by",
      blocking: false,
    });
    expect(byId.get(blocked)).toMatchObject({ blocking: true, following: false });
    expect(byId.get(muted)).toMatchObject({ muting: true, muting_notifications: false });
    expect(byId.get(followerId)).toMatchObject({ followed_by: true, following: false });
    expect(byId.get(remote)).toMatchObject({ note: "far away", following: false });
    for (const id of [unknownRemote, "no-such-account", "rel-batch-missing-0"]) {
      expect(byId.get(id)).toMatchObject({
        following: false,
        followed_by: false,
        blocking: false,
        muting: false,
        endorsed: false,
        note: "",
      });
    }
    expect(batch.at(-3)).toEqual(byId.get(followed));
  });
});
