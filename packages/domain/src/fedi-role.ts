import { assertNever, schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const AdminSchema = unitKind("Admin");
const UserSchema = unitKind("User");

export const FediRoleSchema = z.discriminatedUnion("kind", [AdminSchema, UserSchema]);

export type FediRole = z.infer<typeof FediRoleSchema>;
export type AdminFediRole = z.infer<typeof AdminSchema>;
export type UserFediRole = z.infer<typeof UserSchema>;

const FediRoleNameSchema = z.union([z.literal("admin"), z.literal("user")]);

export type FediRoleName = z.infer<typeof FediRoleNameSchema>;

const METADATA_KEY = "fedi/role";

/**
 * Every Mastodon permission flag (bits 0 through 20). Mastodon reports an
 * administrator's computed permissions as all of them, and its web app
 * checks single flags (manage reports, manage users) to show admin links.
 */
const ALL_PERMISSIONS = "2097151";

export const FediRole = {
  schema: FediRoleSchema,
  parse: schemaResult(FediRoleSchema),
  nameSchema: FediRoleNameSchema,
  metadataKey: METADATA_KEY,
  Admin: { kind: "Admin" } as const satisfies AdminFediRole,
  User: { kind: "User" } as const satisfies UserFediRole,
  fromName: (raw: string): FediRole => {
    const normalized = raw.trim().toLowerCase();
    return normalized === "admin" ? FediRole.Admin : FediRole.User;
  },
  fromMetadata: (metadata: Readonly<Record<string, unknown>> | undefined): FediRole => {
    if (!metadata) {
      return FediRole.User;
    }
    const value = metadata[METADATA_KEY];
    return typeof value === "string" ? FediRole.fromName(value) : FediRole.User;
  },
  toName: (role: FediRole): FediRoleName => {
    switch (role.kind) {
      case "Admin":
        return "admin";
      case "User":
        return "user";
      default:
        return assertNever(role);
    }
  },
  toMastodon: (
    role: FediRole,
  ): Readonly<{
    id: FediRoleName;
    name: "Admin" | "User";
    permissions: "0" | typeof ALL_PERMISSIONS;
    color: "";
    highlighted: boolean;
  }> => {
    switch (role.kind) {
      case "Admin":
        return {
          id: "admin",
          name: "Admin",
          permissions: ALL_PERMISSIONS,
          color: "",
          highlighted: true,
        };
      case "User":
        return {
          id: "user",
          name: "User",
          permissions: "0",
          color: "",
          highlighted: false,
        };
      default:
        return assertNever(role);
    }
  },
  isAdmin: (role: FediRole): boolean => role.kind === "Admin",
  /**
   * Mastodon's `UserRole#bypass_block?`: a highlighted role with moderation
   * permissions that outranks the recipient's. Only Admin is such a role
   * here, and one admin does not outrank another.
   */
  bypassesBlock: (sender: FediRole, recipient: FediRole): boolean =>
    sender.kind === "Admin" && recipient.kind !== "Admin",
} as const;
