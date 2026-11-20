import { describe, expect, it } from "vite-plus/test";
import { IsoInstant } from "./iso-instant";
import { RemoteActor } from "./remote-actor";

describe("RemoteActor.profileUrl", () => {
  const actor = (profileUrl: string | null) => {
    const parsed = RemoteActor.fromFetched({
      actorUri: "https://remote.example/users/bob",
      username: "bob",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/bob/inbox",
      displayName: "Bob",
      profile: { ...RemoteActor.emptyProfile, profileUrl },
      fetchedAt: IsoInstant.parse("2026-09-20T15:00:00.000Z")._unsafeUnwrap(),
    });
    return parsed._unsafeUnwrap();
  };

  it("is the actor's url on its own host", () => {
    expect(RemoteActor.profileUrl(actor("https://REMOTE.example/@bob"))).toBe(
      "https://REMOTE.example/@bob",
    );
  });

  it("is the actor's id when its url is on another host, as Mastodon's mismatching_origin?", () => {
    expect(RemoteActor.profileUrl(actor("https://victim.example/@alice"))).toBe(
      "https://remote.example/users/bob",
    );
    expect(RemoteActor.profileUrl(actor(null))).toBe("https://remote.example/users/bob");
  });
});

describe("RemoteActor", () => {
  it("parses a fetched actor and prefers the shared inbox", () => {
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      return;
    }
    const parsed = RemoteActor.fromFetched({
      actorUri: "https://remote.example/users/bob",
      username: "bob",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/bob/inbox",
      sharedInboxUri: "https://remote.example/inbox",
      displayName: "Bob",
      fetchedAt: fetchedAt.value,
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("RemoteActor");
      expect(RemoteActor.deliveryInbox(parsed.value)).toBe("https://remote.example/inbox");
    }
  });

  it("rejects a non-URL actor id", () => {
    const fetchedAt = IsoInstant.parse("2026-09-20T15:00:00.000Z");
    expect(fetchedAt.isOk()).toBe(true);
    if (fetchedAt.isErr()) {
      return;
    }
    const parsed = RemoteActor.fromFetched({
      actorUri: "not-a-url",
      username: "bob",
      domain: "remote.example",
      inboxUri: "https://remote.example/users/bob/inbox",
      displayName: "Bob",
      fetchedAt: fetchedAt.value,
    });
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.kind).toBe("InvalidActor");
    }
  });
});
