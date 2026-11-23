import type { InboxFollow, InboxFollowRecord, RepositoryError } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { testLocalAccount } from "../test/domain-fixture";
import { type HeldFollow, recordInboxFollow } from "./inbox/follow";

const actorUri = "https://remote.example/users/bob";
const followId = "https://remote.example/follows/1";
const failure = { kind: "RepositoryError", message: "down" } as const satisfies RepositoryError;
const unlocked = testLocalAccount("100", "alice");
const locked = { ...unlocked, locked: true };

const follower = (held: HeldFollow = "None", silenced = false) => ({ actorUri, silenced, held });

const recording = (record: InboxFollowRecord = "Recorded") => {
  const recorded: InboxFollow[] = [];
  return {
    recorded,
    record: async (follow: InboxFollow) => {
      recorded.push(follow);
      return ok(record);
    },
  };
};

describe("recordInboxFollow", () => {
  it("records a first follow of an unlocked account, notifies it and accepts at once", async () => {
    const store = recording();
    const outcome = await recordInboxFollow(store.record, unlocked, follower(), followId);
    expect(outcome).toEqual({ notify: "follow", sendAccept: true });
    expect(store.recorded).toEqual([
      { actorUri, targetAccountId: "100", requiresApproval: false, followActivityId: followId },
    ]);
  });

  it("asks a locked account to approve, without accepting", async () => {
    const store = recording();
    const outcome = await recordInboxFollow(store.record, locked, follower(), followId);
    expect(outcome).toEqual({ notify: "follow_request", sendAccept: false });
    expect(store.recorded[0]?.requiresApproval).toBe(true);
  });

  it("asks an unlocked account to approve a silenced follower, without accepting", async () => {
    const store = recording();
    const outcome = await recordInboxFollow(
      store.record,
      unlocked,
      follower("None", true),
      followId,
    );
    expect(outcome).toEqual({ notify: "follow_request", sendAccept: false });
    expect(store.recorded[0]?.requiresApproval).toBe(true);
  });

  it("accepts again a Follow of a follow it holds, locked or silenced, without notifying", async () => {
    for (const [target, silenced] of [
      [unlocked, false],
      [locked, false],
      [unlocked, true],
    ] as const) {
      const store = recording();
      const outcome = await recordInboxFollow(
        store.record,
        target,
        follower("Following", silenced),
        followId,
      );
      expect(outcome).toEqual({ notify: undefined, sendAccept: true });
      expect(store.recorded[0]?.requiresApproval).toBe(false);
    }
  });

  it("keeps a request it holds pending, with the new Follow's id, without notifying", async () => {
    const store = recording();
    const outcome = await recordInboxFollow(
      store.record,
      unlocked,
      follower("Requested"),
      followId,
    );
    expect(outcome).toEqual({ notify: undefined, sendAccept: false });
    expect(store.recorded).toEqual([
      { actorUri, targetAccountId: "100", requiresApproval: true, followActivityId: followId },
    ]);
  });

  it("neither notifies nor accepts a Follow whose Undo was handled first", async () => {
    const store = recording("UndoneFirst");
    const outcome = await recordInboxFollow(store.record, unlocked, follower(), followId);
    expect(outcome).toEqual({ notify: undefined, sendAccept: false });
  });

  it("does not notify when the follow could not be recorded", async () => {
    const outcome = await recordInboxFollow(
      async () => err(failure),
      unlocked,
      follower(),
      followId,
    );
    expect(outcome.notify).toBeUndefined();
  });
});
