import { describe, expect, it } from "vitest";
import { FollowRequest } from "./follow-request";

describe("FollowRequest", () => {
  it("starts a locked local target as Pending", () => {
    const state = FollowRequest.initial("LocalFollower", true);
    expect(state).toEqual({
      kind: "LocalFollower",
      targetLocked: true,
      follow: { kind: "Pending" },
    } as const satisfies typeof state);
  });

  it("queues a remote follower before a follow row exists", () => {
    const state = FollowRequest.initial("RemoteFollower", true);
    expect(state.kind).toBe("RemoteFollower");
    if (state.kind === "RemoteFollower") {
      expect(state.follow.kind).toBe("None");
      expect(state.remoteRequest.kind).toBe("Queued");
    }
  });

  it("authorizes a pending local follow to Accepted", () => {
    const authorized = FollowRequest.authorize(FollowRequest.initial("LocalFollower", true));
    expect(authorized.kind).toBe("LocalFollower");
    if (authorized.kind === "LocalFollower") {
      expect(authorized.follow.kind).toBe("Accepted");
    }
  });

  it("reject deletes a pending local follow row", () => {
    const rejected = FollowRequest.reject(FollowRequest.initial("LocalFollower", true));
    expect(rejected.kind).toBe("LocalFollower");
    if (rejected.kind === "LocalFollower") {
      expect(rejected.follow.kind).toBe("None");
    }
  });
});
