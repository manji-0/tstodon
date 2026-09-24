import { describe, expect, it } from "vitest";
import {
  AccountId,
  InstanceIdentity,
  IsoInstant,
  LocalAccount,
  LocalStatus,
  MediaId,
  MediaObjectRef,
  Registration,
  StatusComposition,
  StatusId,
  Visibility,
} from "@tstodon/domain";
import {
  activityPayloadFromJson,
  actorDocument,
  noteDocument,
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

const account = (opts?: { avatar?: string; header?: string }) => {
  const intent = Registration.validate(
    Registration.composing({
      username: "alice",
      email: "alice@social.example",
      passwordPresent: true,
      agreement: true,
    }),
  );
  if (intent.isErr()) {
    throw new Error("fixture intent failed");
  }
  const id = AccountId.parse("acct-1");
  const createdAt = IsoInstant.parse("2024-01-01T00:00:00.000Z");
  if (id.isErr() || createdAt.isErr()) {
    throw new Error("fixture ids failed");
  }
  const base = LocalAccount.provision(
    Registration.register(intent.value, id.value, {
      publicKeyPem: "pem",
      privateKeyJwk: "{}",
    }),
    createdAt.value,
  );
  return {
    ...base,
    avatarObjectKey: opts?.avatar ? MediaObjectRef.present(opts.avatar) : MediaObjectRef.none,
    headerObjectKey: opts?.header ? MediaObjectRef.present(opts.header) : MediaObjectRef.none,
  };
};

describe("activitypub local URL parsers", () => {
  it("extracts usernames and status ids from local actor URLs", () => {
    const id = identity();
    expect(parseLocalActorUsername(id, "https://social.example/users/alice")).toBe("alice");
    expect(parseLocalActorUsername(id, "https://social.example/users/alice/inbox")).toBe("alice");
    expect(parseLocalActorUsername(id, "https://other.example/users/alice")).toBeUndefined();
    expect(parseLocalStatusId(id, "https://social.example/users/alice/statuses/status-1")).toBe(
      "status-1",
    );
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

  it("emits icon and image when avatar and header object keys are present", () => {
    const doc = actorDocument(
      identity(),
      account({
        avatar: "avatars/acct-1/blob-a",
        header: "headers/acct-1/blob-h",
      }),
    );
    expect(doc.icon).toEqual({
      type: "Image",
      url: "https://media.social.example/avatars/acct-1/blob-a",
    });
    expect(doc.image).toEqual({
      type: "Image",
      url: "https://media.social.example/headers/acct-1/blob-h",
    });
    expect(actorDocument(identity(), account()).icon).toBeUndefined();
    expect(actorDocument(identity(), account()).image).toBeUndefined();
  });

  it("emits Note attachment Image entries for local media", () => {
    const acct = account();
    const statusId = StatusId.parse("status-1");
    const mediaId = MediaId.parse("media-1");
    const createdAt = IsoInstant.parse("2024-01-01T00:00:00.000Z");
    if (statusId.isErr() || mediaId.isErr() || createdAt.isErr()) {
      throw new Error("fixture ids failed");
    }
    const draft = StatusComposition.validate(
      StatusComposition.composing({
        text: "hi",
        visibility: Visibility.Public,
        mediaIds: [mediaId.value],
      }),
    );
    if (draft.isErr()) {
      throw new Error("fixture draft failed");
    }
    const note = LocalStatus.publish(
      statusId.value,
      acct.id,
      draft.value,
      createdAt.value,
      "<p>hi</p>",
      null,
    );
    const doc = noteDocument(identity(), acct, note, [
      {
        id: mediaId.value,
        account_id: acct.id,
        status_id: statusId.value,
        object_key: "attachments/acct-1/media-1",
        content_type: "image/png",
        created_at: createdAt.value,
        description: "cat",
        focus_x: null,
        focus_y: null,
        preview_object_key: null,
        meta_json: "{}",
        blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
        is_private: 0,
      },
    ]);
    expect(doc.attachment).toEqual({
      type: "Image",
      mediaType: "image/png",
      url: "https://media.social.example/attachments/acct-1/media-1",
      name: "cat",
      blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
    });
  });
});
