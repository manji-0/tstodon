import { describe, expect, it } from "vite-plus/test";
import {
  avatarObjectKey,
  headerObjectKey,
  isLegacyAttachmentObjectKey,
  mediaPublicUrl,
  newAttachmentObjectKey,
  parseMediaObjectKey,
} from "./media-keys";
import { InstanceIdentity } from "@tstodon/domain";

const parsedIdentity = InstanceIdentity.parse({
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
});
if (parsedIdentity.isErr()) {
  throw new Error("fixture identity failed to parse");
}
const identity = parsedIdentity.value;

describe("media-keys", () => {
  it("builds stable object keys and public URLs", () => {
    expect(newAttachmentObjectKey("acct-1")).toMatch(/^attachments\/acct-1\/[0-9a-f]{32}$/);
    expect(newAttachmentObjectKey("acct-1")).not.toBe(newAttachmentObjectKey("acct-1"));
    expect(isLegacyAttachmentObjectKey(newAttachmentObjectKey("acct-1"))).toBe(false);
    expect(isLegacyAttachmentObjectKey("attachments/acct-1/117563206245684194")).toBe(true);
    expect(isLegacyAttachmentObjectKey("avatars/acct-1/117563206245684194")).toBe(false);
    expect(avatarObjectKey("acct-1", "blob-1")).toBe("avatars/acct-1/blob-1");
    expect(headerObjectKey("acct-1", "blob-2")).toBe("headers/acct-1/blob-2");
    expect(mediaPublicUrl(identity, "attachments/acct-1/media-1")).toBe(
      "https://example.com/attachments/acct-1/media-1",
    );
  });

  it("accepts only expected object-key shapes", () => {
    expect(parseMediaObjectKey("attachments/acct-1/media-1")).toBe("attachments/acct-1/media-1");
    expect(parseMediaObjectKey("/avatars/acct-1/blob-1")).toBe("avatars/acct-1/blob-1");
    expect(parseMediaObjectKey("../etc/passwd")).toBeUndefined();
    expect(parseMediaObjectKey("attachments/acct-1/media-1/extra")).toBeUndefined();
    expect(parseMediaObjectKey("other/acct-1/media-1")).toBeUndefined();
    expect(parseMediaObjectKey("emoji/117617487655515663")).toBe("emoji/117617487655515663");
    expect(parseMediaObjectKey("emoji/a/b")).toBeUndefined();
    // A stored emoji is named by its id; `public/emoji/1f600.svg` is a static file.
    expect(parseMediaObjectKey("emoji/1f600.svg")).toBeUndefined();
    expect(parseMediaObjectKey("emoji/1f600")).toBeUndefined();
    expect(parseMediaObjectKey("avatars/blob-1")).toBeUndefined();
  });
});
