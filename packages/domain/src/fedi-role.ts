import { assertNever, schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const AdminSchema = unitKind("Admin");
const UserSchema = unitKind("User");

export const FediRoleSchema = z.discriminatedUnion("kind", [
  AdminSchema,
  UserSchema,
]);

export type FediRole = z.infer<typeof FediRoleSchema>;
export type AdminFediRole = z.infer<typeof AdminSchema>;
export type UserFediRole = z.infer<typeof UserSchema>;

const FediRoleNameSchema = z.union([z.literal("admin"), z.literal("user")]);

export type FediRoleName = z.infer<typeof FediRoleNameSchema>;

const METADATA_KEY = "fedi/role";

export const FediRole = {
  schema: FediRoleSchema,
  parse: schemaResult(FediRoleSchema),
  nameSchema: FediRoleNameSchema,
  metadataKey: METADATA_KEY,
  Admin: { kind: "Admin" } as const satisfies AdminFediRole,
  User: { kind: "User" } as const satisfies UserFediRole,
  fromName: (raw: string): FediRole => {
    const parsed = schemaResult(FediRoleNameSchema)(raw.trim().toLowerCase());
    if (parsed.isOk() && parsed.value === "admin") {
      return FediRole.Admin;
    }
    return FediRole.User;
  },
  fromMetadata: (
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): FediRole => {
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
    permissions: "0" | "1";
    color: "";
    highlighted: boolean;
  }> => {
    switch (role.kind) {
      case "Admin":
        return {
          id: "admin",
          name: "Admin",
          permissions: "1",
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
} as const;
