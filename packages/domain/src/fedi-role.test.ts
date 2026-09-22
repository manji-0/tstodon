import { describe, expect, it } from "vitest";
import { FediRole } from "./fedi-role";

describe("FediRole", () => {
  it("treats only admin as elevated", () => {
    expect(FediRole.fromName("admin")).toEqual(FediRole.Admin);
    expect(FediRole.fromName("ADMIN")).toEqual(FediRole.Admin);
    expect(FediRole.fromName("user")).toEqual(FediRole.User);
    expect(FediRole.fromName("moderator")).toEqual(FediRole.User);
    expect(FediRole.isAdmin(FediRole.Admin)).toBe(true);
    expect(FediRole.isAdmin(FediRole.User)).toBe(false);
  });

  it("reads fedi/role from user metadata", () => {
    expect(FediRole.fromMetadata({ "fedi/role": "admin" })).toEqual(FediRole.Admin);
    expect(FediRole.fromMetadata({ "fedi/role": "user" })).toEqual(FediRole.User);
    expect(FediRole.fromMetadata({ role: "admin" })).toEqual(FediRole.User);
    expect(FediRole.fromMetadata(undefined)).toEqual(FediRole.User);
  });

  it("round-trips names and Mastodon role payloads", () => {
    expect(FediRole.toName(FediRole.Admin)).toBe("admin");
    expect(FediRole.toName(FediRole.User)).toBe("user");
    expect(FediRole.toMastodon(FediRole.Admin)).toMatchObject({
      id: "admin",
      highlighted: true,
    });
    expect(FediRole.toMastodon(FediRole.User)).toMatchObject({
      id: "user",
      highlighted: false,
    });
  });
});
