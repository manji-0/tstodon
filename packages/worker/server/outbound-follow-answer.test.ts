import type { OutboundFollowAnswer, RepositoryError } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { testIdentity, testLocalAccount, testRemoteActor } from "../test/domain-fixture";
import { answerOutboundFollow } from "./outbound-follow";

const identity = testIdentity();
const signer = testRemoteActor("bob");
const alice = testLocalAccount("100", "alice");
const followId = "https://social.example/users/alice/follows/1";

const recording = (accounts: ReadonlyMap<string, typeof alice> = new Map([["alice", alice]])) => {
  const accepted: OutboundFollowAnswer[] = [];
  const rejected: OutboundFollowAnswer[] = [];
  const lookedUp: string[] = [];
  return {
    accepted,
    rejected,
    lookedUp,
    contracts: {
      findAccountByUsername: async (username: string) => {
        lookedUp.push(username);
        return ok(accounts.get(username));
      },
      acceptOutboundFollow: async (answer: OutboundFollowAnswer) => {
        accepted.push(answer);
        return ok(true);
      },
      rejectOutboundFollow: async (answer: OutboundFollowAnswer) => {
        rejected.push(answer);
        return ok(true);
      },
    },
  };
};

const embeddedFollow = (actor: string, object: string) => ({
  id: followId,
  type: "Follow",
  actor,
  object,
});

describe("answerOutboundFollow", () => {
  it("accepts the follow the Accept names by id when it embeds no Follow", async () => {
    const store = recording();
    const answered = await answerOutboundFollow(store.contracts, identity, signer, {
      kind: "Accept",
      objectId: followId,
      object: followId,
    });
    expect(answered.isOk()).toBe(true);
    expect(store.accepted).toEqual([
      { actorUri: signer.actorUri, followActivityId: followId, accountId: undefined },
    ]);
    expect(store.rejected).toEqual([]);
    expect(store.lookedUp).toEqual([]);
  });

  it("names the local follower of an embedded Follow of the signer", async () => {
    const store = recording();
    await answerOutboundFollow(store.contracts, identity, signer, {
      kind: "Reject",
      objectId: followId,
      object: embeddedFollow("https://social.example/users/alice", signer.actorUri),
    });
    expect(store.rejected).toEqual([
      { actorUri: signer.actorUri, followActivityId: followId, accountId: alice.id },
    ]);
    expect(store.accepted).toEqual([]);
  });

  it("ignores an embedded Follow of another actor, so a signer cannot answer for it", async () => {
    const store = recording();
    await answerOutboundFollow(store.contracts, identity, signer, {
      kind: "Accept",
      objectId: followId,
      object: embeddedFollow(
        "https://social.example/users/alice",
        "https://other.example/users/eve",
      ),
    });
    expect(store.lookedUp).toEqual([]);
    expect(store.accepted).toEqual([
      { actorUri: signer.actorUri, followActivityId: followId, accountId: undefined },
    ]);
  });

  it("returns the lookup failure and records nothing", async () => {
    const store = recording();
    const failure: RepositoryError = { kind: "RepositoryError", message: "down" };
    const answered = await answerOutboundFollow(
      { ...store.contracts, findAccountByUsername: async () => err(failure) },
      identity,
      signer,
      {
        kind: "Accept",
        objectId: followId,
        object: embeddedFollow("https://social.example/users/alice", signer.actorUri),
      },
    );
    expect(answered.isErr() ? answered.error : undefined).toEqual(failure);
    expect(store.accepted).toEqual([]);
  });
});
