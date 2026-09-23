import { describe, expect, it } from "vitest";
import { InstanceIdentity } from "./instance-identity";

const sample = () =>
  InstanceIdentity.parse({
    kind: "InstanceIdentity",
    domain: "Social.Example",
    publicOrigin: "https://social.example/",
    name: "tstodon",
    description: "test",
    sourceUrl: "https://github.com/example/tstodon",
    languages: ["en"],
    contactEmail: "admin@social.example",
    thumbnailUrl: "https://social.example/thumbnail.png",
    mediaPublicBaseUrl: "https://media.social.example/",
  });

describe("InstanceIdentity", () => {
  it("strips trailing slash from publicOrigin when building URLs", () => {
    const identity = sample();
    expect(identity.isOk()).toBe(true);
    if (!identity.isOk()) {
      return;
    }
    expect(InstanceIdentity.actorUrl(identity.value, "alice")).toBe(
      "https://social.example/users/alice",
    );
    expect(InstanceIdentity.sharedInboxUrl(identity.value)).toBe("https://social.example/inbox");
  });

  it("builds webfinger subject and encoded resource URL", () => {
    const identity = sample();
    expect(identity.isOk()).toBe(true);
    if (!identity.isOk()) {
      return;
    }
    expect(InstanceIdentity.webfingerSubject(identity.value, "alice")).toBe(
      "acct:alice@social.example",
    );
    expect(InstanceIdentity.webfingerUrl(identity.value, "alice")).toBe(
      "https://social.example/.well-known/webfinger?resource=acct%3Aalice%40social.example",
    );
  });

  it("lowercases and brands the domain on parse", () => {
    const identity = sample();
    expect(identity.isOk()).toBe(true);
    if (identity.isOk()) {
      expect(identity.value.domain).toBe("social.example");
    }
  });
});
