import { describe, expect, it } from "vitest";
import { InstanceIdentity } from "@tstodon/domain";
import {
  activityPayloadFromJson,
  parseLocalActorUsername,
  parseLocalStatusId,
} from "./activitypub";

const identity = () => {
  const parsed = InstanceIdentity.parse({
    kind: "InstanceIdentity",
    domain: "social.example",
    publicOrigin: "https://social.example",
    name: "tstodon",
    description: "test",
    sourceUrl: "https://github.com/example/tstodon",
    languages: ["en"],
    contactEmail: "admin@social.example",
    thumbnailUrl: "https://social.example/thumbnail.png",
    mediaPublicBaseUrl: "https://media.social.example/",
  });
  if (parsed.isErr()) {
    throw new Error("fixture identity failed to parse");
  }
  return parsed.value;
};

describe("activitypub local URL parsers", () => {
  it("extracts usernames and status ids from local actor URLs", () => {
    const id = identity();
    expect(parseLocalActorUsername(id, "https://social.example/users/alice")).toBe("alice");
    expect(parseLocalActorUsername(id, "https://social.example/users/alice/inbox")).toBe("alice");
    expect(parseLocalActorUsername(id, "https://other.example/users/alice")).toBeUndefined();
    expect(
      parseLocalStatusId(id, "https://social.example/users/alice/statuses/status-1"),
    ).toBe("status-1");
    expect(parseLocalStatusId(id, "https://social.example/users/alice")).toBeUndefined();
  });

  it("flattens Activity JSON object ids for domain Activity.parse", () => {
    expect(
      activityPayloadFromJson({
        id: "https://example.com/activities/1",
        type: "Create",
        actor: "https://example.com/users/alice",
        object: "https://example.com/users/alice/statuses/1",
      }),
    ).toEqual({
      kind: "Create",
      id: "https://example.com/activities/1",
      actor: "https://example.com/users/alice",
      object: "https://example.com/users/alice/statuses/1",
    });
    expect(
      activityPayloadFromJson({
        id: "https://example.com/activities/2",
        type: "Announce",
        actor: "https://example.com/users/alice",
        object: { id: "https://example.com/users/bob/statuses/9", type: "Note" },
      }),
    ).toEqual({
      kind: "Announce",
      id: "https://example.com/activities/2",
      actor: "https://example.com/users/alice",
      object: "https://example.com/users/bob/statuses/9",
    });
  });
});
