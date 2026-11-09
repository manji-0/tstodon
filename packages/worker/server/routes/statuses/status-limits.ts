import { characterCount, InstanceLimits } from "@tstodon/core";
import type { StatusDraftError } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { ApiRefusal } from "../api-refusal";

/**
 * A draft the domain refused, as Mastodon's 422: the length error is
 * `StatusLengthValidator`'s, the attachment count `PostStatusService`'s.
 * The `kind` stays the domain's.
 */
export const draftRefusal = (error: StatusDraftError): ApiRefusal => {
  switch (error.kind) {
    case "TooLong":
      return ApiRefusal.rejected(
        422,
        `Validation failed: Text character limit of ${error.limit} exceeded`,
        error.kind,
      );
    case "TooManyMedia":
      return ApiRefusal.rejected(
        422,
        `Cannot attach more than ${InstanceLimits.status.maxMediaAttachments} files`,
        error.kind,
      );
    default:
      return ApiRefusal.rejected(422, error.kind, error.kind);
  }
};

/**
 * The advertised poll limits, for a new poll and an edited one: at most
 * `max_options` options of at most `max_characters_per_option` characters,
 * and an `expires_in` between `min_expiration` and `max_expiration` seconds
 * (Mastodon's `PollOptionsValidator` and `PollExpirationValidator`, which
 * refuse rather than clamp). Fewer than two options is the caller's check.
 */
export const checkPollLimits = (
  options: ReadonlyArray<string>,
  expiresIn: number | undefined,
): Result<void, ApiRefusal> => {
  if (options.length > InstanceLimits.poll.maxOptions) {
    return err(
      ApiRefusal.rejected(
        422,
        `Validation failed: Poll options can't contain more than ${InstanceLimits.poll.maxOptions} items`,
        "PollOptionsOutOfRange",
      ),
    );
  }
  if (options.some((option) => characterCount(option) > InstanceLimits.poll.maxOptionCharacters)) {
    return err(
      ApiRefusal.rejected(
        422,
        `Validation failed: Poll options cannot be longer than ${InstanceLimits.poll.maxOptionCharacters} characters each`,
        "PollOptionTooLong",
      ),
    );
  }
  if (expiresIn === undefined) {
    return ok(undefined);
  }
  if (!Number.isFinite(expiresIn) || expiresIn > InstanceLimits.poll.maxExpirationSeconds) {
    return err(
      ApiRefusal.rejected(
        422,
        "Validation failed: Poll expires at is too far into the future",
        "PollExpiration",
      ),
    );
  }
  if (expiresIn < InstanceLimits.poll.minExpirationSeconds) {
    return err(
      ApiRefusal.rejected(422, "Validation failed: Poll expires at is too soon", "PollExpiration"),
    );
  }
  return ok(undefined);
};
