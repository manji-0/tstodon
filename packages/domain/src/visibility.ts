import type { StatusVisibility, StatusVisibilityParam } from "@tstodon/api/values";
import { assertNever, schemaResult, unitKind } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const PublicSchema = unitKind("Public");
const UnlistedSchema = unitKind("Unlisted");
const FollowersOnlySchema = unitKind("FollowersOnly");
const DirectSchema = unitKind("Direct");
const LimitedSchema = unitKind("Limited");

/**
 * What an account may make the default of its posts: every visibility but
 * `Limited`, which `UserSettings#default_privacy` does not take.
 */
export const SelectableVisibilitySchema = z.discriminatedUnion("kind", [
  PublicSchema,
  UnlistedSchema,
  FollowersOnlySchema,
  DirectSchema,
]);

/**
 * A status's visibility, Mastodon's `Status#visibility` enum. `Limited` is a
 * status only the accounts it mentions may see, as a direct one, without
 * being one: a remote note its audience makes direct but that reaches an
 * account it does not tag (`Create#process_audience`), or a local status
 * posted `visibility=limited`.
 */
export const VisibilitySchema = z.discriminatedUnion("kind", [
  ...SelectableVisibilitySchema.options,
  LimitedSchema,
]);

export type Visibility = z.infer<typeof VisibilitySchema>;
export type SelectableVisibility = z.infer<typeof SelectableVisibilitySchema>;
export type PublicVisibility = z.infer<typeof PublicSchema>;
export type UnlistedVisibility = z.infer<typeof UnlistedSchema>;
export type FollowersOnlyVisibility = z.infer<typeof FollowersOnlySchema>;
export type DirectVisibility = z.infer<typeof DirectSchema>;
export type LimitedVisibility = z.infer<typeof LimitedSchema>;

export type VisibilityParseError = Readonly<{
  kind: "Unknown";
  value: string;
}>;

const selectableFromParam = (raw: string): Result<SelectableVisibility, VisibilityParseError> => {
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
};

const requiresMention = (visibility: Visibility): boolean => {
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
};

export const Visibility = {
  schema: VisibilitySchema,
  parse: schemaResult(VisibilitySchema),
  Public: { kind: "Public" } as const satisfies PublicVisibility,
  Unlisted: { kind: "Unlisted" } as const satisfies UnlistedVisibility,
  FollowersOnly: {
    kind: "FollowersOnly",
  } as const satisfies FollowersOnlyVisibility,
  Direct: { kind: "Direct" } as const satisfies DirectVisibility,
  Limited: { kind: "Limited" } as const satisfies LimitedVisibility,
  /**
   * A `visibility` param, or a stored visibility: any value of the enum,
   * `limited` included, as `PostStatusService` stores whatever the enum holds.
   */
  fromParam: (raw: string): Result<Visibility, VisibilityParseError> =>
    raw.trim().toLowerCase() === "limited" ? ok(Visibility.Limited) : selectableFromParam(raw),
  /** A default an account picks (`source[privacy]`, the preferences form): not `limited`. */
  selectableFromParam,
  /** As a column, a job and a scheduled status's params keep it. */
  toParam: (visibility: Visibility): StatusVisibilityParam =>
    visibility.kind === "Limited" ? "limited" : Visibility.toRest(visibility),
  /** As the REST API renders a status: `limited` shows as `private` (`REST::StatusSerializer#visibility`). */
  toRest: (visibility: Visibility): StatusVisibility => {
    switch (visibility.kind) {
      case "Public":
        return "public";
      case "Unlisted":
        return "unlisted";
      case "FollowersOnly":
      case "Limited":
        return "private";
      case "Direct":
        return "direct";
      default:
        return assertNever(visibility);
    }
  },
  /** `Status#distributable?`: public or unlisted. */
  distributable: (visibility: Visibility): boolean =>
    visibility.kind === "Public" || visibility.kind === "Unlisted",
  /** `StatusPolicy#requires_mention?`: only the accounts a direct or limited status names may see it. */
  requiresMention,
  /** Not distributable: followers-only, direct or limited. */
  isRestricted: (visibility: Visibility): boolean =>
    visibility.kind === "FollowersOnly" || requiresMention(visibility),
  /**
   * `Create#process_audience`: a note its audience makes direct is limited
   * when an account Mastodon knows is in its `to`/`cc` without a `Mention`
   * tag, or owns the personal inbox it was delivered to without one.
   */
  ofAudience: (visibility: Visibility, audience: Readonly<{ audienceOnly: boolean }>): Visibility =>
    visibility.kind === "Direct" && audience.audienceOnly ? Visibility.Limited : visibility,
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
