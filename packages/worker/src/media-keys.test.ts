import { describe, expect, it } from "vitest";
import {
  attachmentObjectKey,
  avatarObjectKey,
  headerObjectKey,
  mediaPublicUrl,
  parseMediaObjectKey,
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
  });
});
