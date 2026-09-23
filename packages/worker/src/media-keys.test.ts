import { describe, expect, it } from "vitest";
import {
  attachmentObjectKey,
  attachmentPreviewObjectKey,
  avatarObjectKey,
  headerObjectKey,
  isPrivateMediaObjectKey,
  mediaAuthUrl,
  mediaPublicUrl,
  parseMediaObjectKey,
  privateAttachmentObjectKey,
} from "./media-keys";
import type { InstanceIdentity } from "@tstodon/domain";

const identity = {
  kind: "InstanceIdentity",
  domain: "example.com",
  publicOrigin: "https://example.com",
  name: "tstodon",
  description: "",
  sourceUrl: "https://github.com/example/tstodon",
  languages: ["en"],
  contactEmail: "admin@example.com",
  thumbnailUrl: "https://example.com/site/thumbnail.png",
  mediaPublicBaseUrl: "https://example.com/",
} as const satisfies InstanceIdentity;

describe("media-keys", () => {
  it("builds stable object keys and public URLs", () => {
    expect(attachmentObjectKey("acct-1", "media-1")).toBe("attachments/acct-1/media-1");
    expect(attachmentPreviewObjectKey("acct-1", "media-1")).toBe(
      "attachments/acct-1/media-1/preview",
    );
    expect(privateAttachmentObjectKey("acct-1", "media-1")).toBe(
      "private/attachments/acct-1/media-1",
    );
    expect(avatarObjectKey("acct-1", "blob-1")).toBe("avatars/acct-1/blob-1");
    expect(headerObjectKey("acct-1", "blob-2")).toBe("headers/acct-1/blob-2");
    expect(mediaPublicUrl(identity, "attachments/acct-1/media-1")).toBe(
      "https://example.com/attachments/acct-1/media-1",
    );
    expect(mediaAuthUrl(identity, "media-1")).toBe("https://example.com/media/media-1");
  });

  it("accepts only expected object-key shapes", () => {
    expect(parseMediaObjectKey("attachments/acct-1/media-1")).toBe("attachments/acct-1/media-1");
    expect(parseMediaObjectKey("attachments/acct-1/media-1/preview")).toBe(
      "attachments/acct-1/media-1/preview",
    );
    expect(parseMediaObjectKey("/avatars/acct-1/blob-1")).toBe("avatars/acct-1/blob-1");
    expect(parseMediaObjectKey("../etc/passwd")).toBeUndefined();
    expect(parseMediaObjectKey("attachments/acct-1/media-1/extra")).toBeUndefined();
    expect(parseMediaObjectKey("other/acct-1/media-1")).toBeUndefined();
    expect(parseMediaObjectKey("private/attachments/acct-1/media-1")).toBeUndefined();
    expect(isPrivateMediaObjectKey("private/attachments/acct-1/media-1")).toBe(true);
    expect(isPrivateMediaObjectKey("attachments/acct-1/media-1")).toBe(false);
  });
});
