import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { listFollowers, listFollowing } from "./follow-store";
import type { IdCursor } from "./id-cursor";
import { RemoteAccountId } from "./remote-account-id";
import { upsertRemoteActor } from "./remote-actor-store";

const accountId = async (email: string): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  const parsed = schemaResult(z.object({ id: z.string() }))(await response.json());
  if (parsed.isErr()) {
    throw new Error("verify_credentials rejected");
  }
  return parsed.value.id;
};

const remoteActor = async (name: string): Promise<string> => {
  const actorUri = `https://merge.example/users/${name}`;
  const fetchedAt = IsoInstant.parse("2026-11-01T00:00:00.000Z");
  if (fetchedAt.isErr()) {
    throw new Error("invalid fixture instant");
  }
  const actor = RemoteActor.fromFetched({
    actorUri,
    username: name,
    domain: "merge.example",
    inboxUri: `${actorUri}/inbox`,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: "unused",
    displayName: name,
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("remote actor fixture rejected");
  }
  expect((await upsertRemoteActor(env.DB, actor.value)).isOk()).toBe(true);
  return actorUri;
};

const edgeIds = async (
  list: typeof listFollowers,
  owner: string,
  limit: number,
  cursor?: IdCursor,
): Promise<string[]> => {
  const edges = await list(env.DB, owner, limit, cursor);
  if (edges.isErr()) {
    throw new Error(edges.error.message);
  }
  return edges.value.map((edge) => edge.id);
};

/**
 * Local and remote follows interleave by row id; `Pending` / `Requested`
 * rows sit between them and must stay out of every page.
 */
describe("follower and following lists across local and remote follows", () => {
  it("merges both kinds in follow row id order for every cursor", async () => {
    const owner = await accountId("merge-owner@example.com");
    const locals = [
      await accountId("merge-a@example.com"),
      await accountId("merge-b@example.com"),
      await accountId("merge-c@example.com"),
    ];
    const pendingLocal = await accountId("merge-d@example.com");
    const remotes = [await remoteActor("r1"), await remoteActor("r2"), await remoteActor("r3")];
    const pendingRemote = await remoteActor("r4");

    const statements = [
      ...locals.flatMap((local, index) => [
        env.DB.prepare(
          "INSERT INTO follows (id, follower_account_id, target_account_id, kind) VALUES (?, ?, ?, 'Accepted')",
        ).bind(`9${index * 2 + 1}0`, local, owner),
        env.DB.prepare(
          "INSERT INTO follows (id, follower_account_id, target_account_id, kind) VALUES (?, ?, ?, 'Accepted')",
        ).bind(`9${index * 2 + 1}1`, owner, local),
      ]),
      ...remotes.flatMap((actorUri, index) => [
        env.DB.prepare(
          `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
           VALUES (?, ?, ?, 'Accepted', 'Accepted')`,
        ).bind(`9${index * 2 + 2}0`, actorUri, owner),
        env.DB.prepare(
          `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
           VALUES (?, ?, ?, ?, 'Accepted')`,
        ).bind(`9${index * 2 + 2}1`, owner, actorUri, `https://example.com/follows/m${index}`),
      ]),
      env.DB.prepare(
        "INSERT INTO follows (id, follower_account_id, target_account_id, kind) VALUES ('945', ?, ?, 'Pending')",
      ).bind(pendingLocal, owner),
      env.DB.prepare(
        "INSERT INTO follows (id, follower_account_id, target_account_id, kind) VALUES ('946', ?, ?, 'Pending')",
      ).bind(owner, pendingLocal),
      env.DB.prepare(
        `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind)
         VALUES ('935', ?, ?, 'Pending', 'Pending')`,
      ).bind(pendingRemote, owner),
      env.DB.prepare(
        `INSERT INTO outbound_follows (id, account_id, actor_uri, follow_activity_id, state)
         VALUES ('936', ?, ?, 'https://example.com/follows/m-pending', 'Requested')`,
      ).bind(owner, pendingRemote),
    ];
    await env.DB.batch(statements);

    const followers = ["960", "950", "940", "930", "920", "910"];
    expect(await edgeIds(listFollowers, owner, 40)).toEqual(followers);
    expect(await edgeIds(listFollowers, owner, 2, { maxId: "950" })).toEqual(["940", "930"]);
    expect(await edgeIds(listFollowers, owner, 2, { sinceId: "920" })).toEqual(["960", "950"]);
    expect(await edgeIds(listFollowers, owner, 2, { minId: "920" })).toEqual(["930", "940"]);
    const edges = await listFollowers(env.DB, owner, 2);
    expect(edges.isOk() ? edges.value.map((edge) => edge.accountId) : []).toEqual([
      RemoteAccountId.encode(remotes[2] ?? ""),
      locals[2],
    ]);

    const following = ["961", "951", "941", "931", "921", "911"];
    expect(await edgeIds(listFollowing, owner, 40)).toEqual(following);
    expect(await edgeIds(listFollowing, owner, 2, { maxId: "951" })).toEqual(["941", "931"]);
    expect(await edgeIds(listFollowing, owner, 2, { sinceId: "921" })).toEqual(["961", "951"]);
    expect(await edgeIds(listFollowing, owner, 2, { minId: "921" })).toEqual(["931", "941"]);
  });
});
