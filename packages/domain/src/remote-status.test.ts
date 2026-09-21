import { describe, expect, it } from "vitest";
import { IsoInstant } from "./iso-instant";
import { RemoteStatus } from "./remote-status";
import { StatusId } from "./status-id";
import { Visibility } from "./visibility";

describe("RemoteStatus", () => {
  it("maps ActivityPub audience to visibility", () => {
    expect(
      RemoteStatus.visibilityFromAudience(
        ["https://www.w3.org/ns/activitystreams#Public"],
        [],
      ),
    ).toEqual(Visibility.Public);
    expect(
      RemoteStatus.visibilityFromAudience(
        ["https://remote.example/users/bob/followers"],
        ["https://www.w3.org/ns/activitystreams#Public"],
      ),
    ).toEqual(Visibility.Unlisted);
    expect(
      RemoteStatus.visibilityFromAudience(
        ["https://remote.example/users/bob/followers"],
        [],
      ),
    ).toEqual(Visibility.FollowersOnly);
    expect(RemoteStatus.visibilityFromAudience([], [])).toEqual(Visibility.Direct);
  });

  it("parses a fetched remote note", () => {
    const id = StatusId.parse("remote-note-1");
    const publishedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(id.isOk() && publishedAt.isOk()).toBe(true);
    if (id.isErr() || publishedAt.isErr()) {
      return;
    }
    const parsed = RemoteStatus.fromFetched({
      id: id.value,
      actorUri: "https://remote.example/users/bob",
      objectUri: "https://remote.example/users/bob/statuses/1",
      contentHtml: "<p>hello federation</p>",
      spoilerText: "",
      visibility: Visibility.Public,
      sensitive: false,
      language: { kind: "None" },
      publishedAt: publishedAt.value,
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("RemoteNote");
    }
  });
});
