import { describe, expect, it } from "vitest";
import { IsoInstant } from "./iso-instant";
import { RemoteActor } from "./remote-actor";

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
      publicKeyId: "https://remote.example/users/bob#main-key",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      displayName: "Bob",
      fetchedAt: fetchedAt.value,
    });
    expect(parsed.isOk()).toBe(true);
    if (parsed.isOk()) {
      expect(parsed.value.kind).toBe("RemoteActor");
      expect(RemoteActor.deliveryInbox(parsed.value)).toBe(
        "https://remote.example/inbox",
      );
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
      publicKeyId: "https://remote.example/users/bob#main-key",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----",
      displayName: "Bob",
      fetchedAt: fetchedAt.value,
    });
    expect(parsed.isErr()).toBe(true);
    if (parsed.isErr()) {
      expect(parsed.error.kind).toBe("InvalidActor");
    }
  });
});
