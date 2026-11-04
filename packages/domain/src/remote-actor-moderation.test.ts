import { describe, expect, it } from "vite-plus/test";
import { RemoteActorModeration } from "./remote-actor-moderation";

const start = RemoteActorModeration.inGoodStanding;

describe("RemoteActorModeration", () => {
  it("silences, suspends and lifts each standing on its own", () => {
    const silenced = RemoteActorModeration.apply(start, "silence");
    expect(silenced.standing.kind).toBe("Silenced");
    expect(RemoteActorModeration.apply(silenced, "unsilence")).toEqual(start);
    const suspended = RemoteActorModeration.apply(silenced, "suspend");
    expect(suspended.standing.kind).toBe("Suspended");
    expect(RemoteActorModeration.apply(suspended, "unsilence")).toEqual(suspended);
    expect(RemoteActorModeration.apply(suspended, "silence")).toEqual(suspended);
    expect(RemoteActorModeration.apply(suspended, "unsuspend")).toEqual(start);
  });

  it("keeps the sensitive flag across standing changes", () => {
    const sensitized = RemoteActorModeration.apply(start, "sensitize");
    expect(RemoteActorModeration.isDefault(sensitized)).toBe(false);
    expect(RemoteActorModeration.apply(sensitized, "suspend").sensitized).toBe(true);
    const cleared = RemoteActorModeration.apply(sensitized, "unsensitize");
    expect(RemoteActorModeration.isDefault(cleared)).toBe(true);
  });
});
