import type { StatusVisibility } from "@tstodon/api/values";
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
  toMastodon: (visibility: Visibility): StatusVisibility => {
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

const LimitedSchema = unitKind("Limited");

/**
 * A remote status's visibility: a local one's, or `Limited`, Mastodon's
 * `limited`. That is a note that would be direct but reaches an account
 * Mastodon knows only through its audience (`Create#process_audience`). A
 * local status is never limited, so `Visibility` has no such variant.
 */
export const RemoteVisibilitySchema = z.discriminatedUnion("kind", [
  ...VisibilitySchema.options,
  LimitedSchema,
]);

export type RemoteVisibility = z.infer<typeof RemoteVisibilitySchema>;
export type LimitedVisibility = z.infer<typeof LimitedSchema>;

/** A remote visibility as `remote_statuses.visibility` keeps it. */
export type StoredRemoteVisibility = StatusVisibility | "limited";

export const RemoteVisibility = {
  schema: RemoteVisibilitySchema,
  parse: schemaResult(RemoteVisibilitySchema),
  Limited: { kind: "Limited" } as const satisfies LimitedVisibility,
  fromStored: (raw: string): Result<RemoteVisibility, VisibilityParseError> =>
    raw === "limited" ? ok(RemoteVisibility.Limited) : Visibility.fromMastodon(raw),
  toStored: (visibility: RemoteVisibility): StoredRemoteVisibility =>
    visibility.kind === "Limited" ? "limited" : Visibility.toMastodon(visibility),
  /** As the REST API renders it: `limited` shows as `private` (`REST::StatusSerializer#visibility`). */
  toMastodon: (visibility: RemoteVisibility): StatusVisibility =>
    visibility.kind === "Limited" ? "private" : Visibility.toMastodon(visibility),
  /** `StatusPolicy#requires_mention?`: only the accounts a direct or limited note names may see it. */
  requiresMention: (visibility: RemoteVisibility): boolean => {
    switch (visibility.kind) {
      case "Direct":
      case "Limited":
        return true;
      case "Public":
      case "Unlisted":
      case "FollowersOnly":
        return false;
      default:
        return assertNever(visibility);
    }
  },
  isRestricted: (visibility: RemoteVisibility): boolean =>
    visibility.kind === "FollowersOnly" || RemoteVisibility.requiresMention(visibility),
  /**
   * `Create#process_audience`: a note its audience makes direct is limited
   * when an account Mastodon knows is in its `to`/`cc` without a `Mention`
   * tag, or owns the personal inbox it was delivered to without one.
   */
  ofAudience: (
    visibility: RemoteVisibility,
    audience: Readonly<{ audienceOnly: boolean }>,
  ): RemoteVisibility =>
    visibility.kind === "Direct" && audience.audienceOnly ? RemoteVisibility.Limited : visibility,
} as const;

/**
 * Mastodon's reblog visibility: a restricted original (private or direct)
 * keeps its own visibility, so a boost is never more visible than the status
 * it shares; otherwise the requested visibility wins, then the account default.
 */
export const reblogVisibility = (
  original: Visibility,
  requested: Visibility | undefined,
  fallback: Visibility,
): Visibility =>
  Visibility.isRestricted(original) ? original : requested === undefined ? fallback : requested;
