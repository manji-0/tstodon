import { describe, expect, it } from "vite-plus/test";
import { ActivityId } from "./activity-id";
import { IsoInstant } from "./iso-instant";
import { RemoteBoost } from "./remote-boost";
import { StatusId } from "./status-id";
import { Visibility, type Visibility as VisibilityValue } from "./visibility";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const FOLLOWERS = "https://remote.example/users/booster/followers";

const announce = (targetVisibility: VisibilityValue, to: string[], cc: string[]) => {
  const id = StatusId.parse("100");
  const target = StatusId.parse("50");
  const activityId = ActivityId.parse("https://remote.example/users/booster/statuses/1/activity");
  const publishedAt = IsoInstant.parse("2026-10-20T00:00:00.000Z");
  if (id.isErr() || target.isErr() || activityId.isErr() || publishedAt.isErr()) {
    throw new Error("invalid fixture");
  }
  return RemoteBoost.fromAnnounce({
    id: id.value,
    actorUri: "https://remote.example/users/booster",
    activityId: activityId.value,
    target: { kind: "RemoteStatus", statusId: target.value },
    targetVisibility,
    to,
    cc,
    publishedAt: publishedAt.value,
  });
};

describe("RemoteBoost.fromAnnounce", () => {
  it("takes the boost's visibility from the Announce audience", () => {
    expect(announce(Visibility.Public, [PUBLIC], [FOLLOWERS])._unsafeUnwrap().visibility).toEqual(
      Visibility.Public,
    );
    expect(announce(Visibility.Public, [FOLLOWERS], [PUBLIC])._unsafeUnwrap().visibility).toEqual(
      Visibility.Unlisted,
    );
    expect(announce(Visibility.Unlisted, [FOLLOWERS], [])._unsafeUnwrap().visibility).toEqual(
      Visibility.FollowersOnly,
    );
  });

  it("refuses a restricted original and a direct Announce", () => {
    expect(announce(Visibility.FollowersOnly, [PUBLIC], [])._unsafeUnwrapErr()).toEqual({
      kind: "NotAnnounceable",
    });
    expect(announce(Visibility.Direct, [PUBLIC], [])._unsafeUnwrapErr()).toEqual({
      kind: "NotAnnounceable",
    });
    expect(announce(Visibility.Public, [], [])._unsafeUnwrapErr()).toEqual({
      kind: "DirectAudience",
    });
  });
});
