import { assertNever, schemaResult, unitKind } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const PublicSchema = unitKind("Public");
const UnlistedSchema = unitKind("Unlisted");
const FollowersOnlySchema = unitKind("FollowersOnly");
const DirectSchema = unitKind("Direct");

export const VisibilitySchema = z.discriminatedUnion("kind", [
  PublicSchema,
  UnlistedSchema,
  FollowersOnlySchema,
  DirectSchema,
]);

export type Visibility = z.infer<typeof VisibilitySchema>;
export type PublicVisibility = z.infer<typeof PublicSchema>;
export type UnlistedVisibility = z.infer<typeof UnlistedSchema>;
export type FollowersOnlyVisibility = z.infer<typeof FollowersOnlySchema>;
export type DirectVisibility = z.infer<typeof DirectSchema>;

export type VisibilityParseError = Readonly<{
  kind: "Unknown";
  value: string;
}>;

export const Visibility = {
  schema: VisibilitySchema,
  parse: schemaResult(VisibilitySchema),
  Public: { kind: "Public" } as const satisfies PublicVisibility,
  Unlisted: { kind: "Unlisted" } as const satisfies UnlistedVisibility,
  FollowersOnly: {
    kind: "FollowersOnly",
  } as const satisfies FollowersOnlyVisibility,
  Direct: { kind: "Direct" } as const satisfies DirectVisibility,
  fromMastodon: (raw: string): Result<Visibility, VisibilityParseError> => {
    switch (raw.trim().toLowerCase()) {
      case "public":
        return ok(Visibility.Public);
      case "unlisted":
        return ok(Visibility.Unlisted);
      case "private":
        return ok(Visibility.FollowersOnly);
      case "direct":
        return ok(Visibility.Direct);
      default:
        return err({ kind: "Unknown", value: raw });
    }
  },
  toMastodon: (visibility: Visibility): "public" | "unlisted" | "private" | "direct" => {
    switch (visibility.kind) {
      case "Public":
        return "public";
      case "Unlisted":
        return "unlisted";
      case "FollowersOnly":
        return "private";
      case "Direct":
        return "direct";
      default:
        return assertNever(visibility);
    }
  },
  isRestricted: (visibility: Visibility): boolean =>
    visibility.kind === "FollowersOnly" || visibility.kind === "Direct",
} as const;
