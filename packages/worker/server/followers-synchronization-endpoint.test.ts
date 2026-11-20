import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApFollowersSynchronizationCollection } from "@tstodon/api/activitypub";
import { signedInAccount } from "../test/auth-fixture";
import { expectContract } from "../test/api-contract";
import { type Remote, remoteActor } from "../test/remote-actor-fixture";

const followedBy = async (remote: Remote, username: string, name: string): Promise<void> => {
  expect(
    await remote.send({
      id: `${remote.actorUri}#follows/${name}`,
      type: "Follow",
      object: `https://example.com/users/${username}`,
    }),
  ).toBe(202);
};

describe("GET /users/:username/followers_synchronization", () => {
  it("lists the account's followers on the signer's host only", async () => {
    const { username } = await signedInAccount("sync-endpoint-list@example.com");
    const bob = await remoteActor("sync-endpoint-bob", "sync.example");
    const carol = await remoteActor("sync-endpoint-carol", "sync.example");
    const lookalike = await remoteActor("sync-endpoint-dave", "sync.example.org");
    const other = await remoteActor("sync-endpoint-erin", "other.example");
    await followedBy(bob, username, "bob");
    await followedBy(carol, username, "carol");
    await followedBy(lookalike, username, "dave");
    await followedBy(other, username, "erin");

    const response = await bob.fetch(`/users/${username}/followers_synchronization`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/activity+json");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private");
    const collection = expectContract(ApFollowersSynchronizationCollection, await response.json());
    expect(collection.id).toBe(`https://example.com/users/${username}/followers_synchronization`);
    expect(collection).not.toHaveProperty("totalItems");
    expect([...collection.orderedItems].sort()).toEqual([bob.actorUri, carol.actorUri].sort());

    const fromOther = await other.fetch(`/users/${username}/followers_synchronization`);
    expect(
      expectContract(ApFollowersSynchronizationCollection, await fromOther.json()).orderedItems,
    ).toEqual([other.actorUri]);
  });

  it("needs a signature, as require_account_signature!", async () => {
    const { username } = await signedInAccount("sync-endpoint-unsigned@example.com");
    const response = await SELF.fetch(
      `https://example.com/users/${username}/followers_synchronization`,
      { headers: { Accept: "application/activity+json" } },
    );
    expect(response.status).toBe(401);
  });

  it("answers 404 for an account nobody has, before the signature", async () => {
    const response = await SELF.fetch(
      "https://example.com/users/nobody-sync-endpoint/followers_synchronization",
    );
    expect(response.status).toBe(404);
  });
});
