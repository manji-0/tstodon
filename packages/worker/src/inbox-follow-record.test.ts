import type { InboxFollow, RepositoryError } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { testLocalAccount } from "../test/domain-fixture";
import { recordInboxFollow } from "./inbox/follow";

const actorUri = "https://remote.example/users/bob";
const followId = "https://remote.example/follows/1";
const failure = { kind: "RepositoryError", message: "down" } as const satisfies RepositoryError;
const unlocked = testLocalAccount("100", "alice");
const locked = { ...unlocked, locked: true };

const recording = (already: boolean) => {
  const recorded: InboxFollow[] = [];
  return {
    recorded,
    contracts: {
      hasRemoteFollow: async () => ok(already),
      recordInboxFollow: async (follow: InboxFollow) => {
        recorded.push(follow);
        return ok(undefined);
      },
    },
  };
};

describe("recordInboxFollow", () => {
  it("records a first follow of an unlocked account, notifies it and accepts at once", async () => {
    const store = recording(false);
    const outcome = await recordInboxFollow(store.contracts, unlocked, actorUri, followId);
    expect(outcome).toEqual({ notify: "follow", sendAccept: true });
    expect(store.recorded).toEqual([
      { actorUri, targetAccountId: "100", targetLocked: false, followActivityId: followId },
    ]);
  });

  it("asks a locked account to approve, without accepting", async () => {
    const store = recording(false);
    const outcome = await recordInboxFollow(store.contracts, locked, actorUri, followId);
    expect(outcome).toEqual({ notify: "follow_request", sendAccept: false });
    expect(store.recorded[0]?.targetLocked).toBe(true);
  });

  it("does not notify again for a redelivered Follow", async () => {
    const store = recording(true);
    const outcome = await recordInboxFollow(store.contracts, unlocked, actorUri, followId);
    expect(outcome).toEqual({ notify: undefined, sendAccept: true });
  });

  it("does not notify when the follow could not be recorded", async () => {
    const store = recording(false);
    const outcome = await recordInboxFollow(
      { ...store.contracts, recordInboxFollow: async () => err(failure) },
      unlocked,
      actorUri,
      followId,
    );
    expect(outcome.notify).toBeUndefined();
  });
});
