import { describe, expect, it } from "vite-plus/test";
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
    // The web app shows its moderation links for the manage-reports (0x10)
    // and manage-users (0x400) flags.
    const adminPermissions = Number(FediRole.toMastodon(FediRole.Admin).permissions);
    expect(adminPermissions & 0x10).toBe(0x10);
    expect(adminPermissions & 0x400).toBe(0x400);
    expect(FediRole.toMastodon(FediRole.User).permissions).toBe("0");
    expect(FediRole.toMastodon(FediRole.User)).toMatchObject({
      id: "user",
      highlighted: false,
    });
  });
});
