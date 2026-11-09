import { schemaResult, unitKind } from "@tstodon/core";
import { z } from "zod";

const SuccessSchema = unitKind("Success");

/** The remote answered with a status worth retrying (5xx, 401, 408, 429). */
const HttpStatusCauseSchema = z.object({
  kind: z.literal("HttpStatus"),
  httpStatus: z.number().int(),
});
/** 429 or 503 with a `Retry-After` this server can read: wait at least that long. */
const ThrottledCauseSchema = z.object({
  kind: z.literal("Throttled"),
  httpStatus: z.number().int(),
  retryAfterSeconds: z.number().int().nonnegative(),
});
/** No HTTP answer: DNS, connect, TLS or a reset. */
const NetworkCauseSchema = unitKind("Network");
/**
 * This server could not make the request (D1 or the signing key unavailable,
 * the instance misconfigured). Says nothing about the remote.
 */
const LocalCauseSchema = unitKind("Local");

export const TransientFailureCauseSchema = z.discriminatedUnion("kind", [
  HttpStatusCauseSchema,
  ThrottledCauseSchema,
  NetworkCauseSchema,
  LocalCauseSchema,
]);

export type TransientFailureCause = z.infer<typeof TransientFailureCauseSchema>;

const TransientFailureSchema = z.object({
  kind: z.literal("TransientFailure"),
  cause: TransientFailureCauseSchema,
});
const PermanentFailureSchema = z.object({
  kind: z.literal("PermanentFailure"),
  httpStatus: z.number().int().min(400).max(599),
});

export const DeliveryAttemptOutcomeSchema = z.discriminatedUnion("kind", [
  SuccessSchema,
  TransientFailureSchema,
  PermanentFailureSchema,
]);

export type DeliveryAttemptOutcome = z.infer<typeof DeliveryAttemptOutcomeSchema>;

/**
 * Mastodon's `response_error_unsalvageable?` (`JsonLdHelper`): a 4xx other
 * than 401, 408 and 429, or a 501, will not change by asking again.
 */
const unsalvageable = (status: number): boolean =>
  status === 501 || (status >= 400 && status <= 499 && ![401, 408, 429].includes(status));

/** What a delivery attempt says about the remote server, for `DeliveryDomainHealth`. */
export type DeliveryReachability = "Reachable" | "Unreachable" | "Unknown";

export const DeliveryAttemptOutcome = {
  schema: DeliveryAttemptOutcomeSchema,
  parse: schemaResult(DeliveryAttemptOutcomeSchema),
  Success: { kind: "Success" } as const satisfies DeliveryAttemptOutcome,
  /** The request never got an HTTP answer. */
  Network: {
    kind: "TransientFailure",
    cause: { kind: "Network" },
  } as const satisfies DeliveryAttemptOutcome,
  /** This server could not send the request; retried, but not held against the remote. */
  Local: {
    kind: "TransientFailure",
    cause: { kind: "Local" },
  } as const satisfies DeliveryAttemptOutcome,
  /**
   * Classify an inbox's answer. `retryAfterSeconds` is the response's
   * `Retry-After` (see {@link DeliveryAttemptOutcome.retryAfterSeconds}); it
   * only counts on a 429 or 503.
   */
  forHttpStatus: (status: number, retryAfterSeconds?: number): DeliveryAttemptOutcome => {
    if (status >= 200 && status <= 299) {
      return DeliveryAttemptOutcome.Success;
    }
    if (unsalvageable(status)) {
      return { kind: "PermanentFailure", httpStatus: status };
    }
    if ((status === 429 || status === 503) && retryAfterSeconds !== undefined) {
      return {
        kind: "TransientFailure",
        cause: { kind: "Throttled", httpStatus: status, retryAfterSeconds },
      };
    }
    return { kind: "TransientFailure", cause: { kind: "HttpStatus", httpStatus: status } };
  },
  /**
   * A `Retry-After` header in seconds from `nowMs`: delta-seconds, or an
   * HTTP-date (a past date is 0). `undefined` when absent or unreadable.
   */
  retryAfterSeconds: (header: string | null, nowMs: number): number | undefined => {
    if (header === null) {
      return undefined;
    }
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
    // An HTTP-date names its day and month ("Wed, 21 Oct 2015 07:28:00 GMT");
    // a bare number Date.parse would read as a year is not one.
    const at = /[a-z]/i.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
    return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - nowMs) / 1000));
  },
  /**
   * Whether the remote answered. Any answer the remote meant, a permanent
   * refusal included, shows it is up, as Mastodon's `DeliveryFailureTracker`
   * records a failure only for an error the worker retries.
   */
  reachability: (outcome: DeliveryAttemptOutcome): DeliveryReachability => {
    switch (outcome.kind) {
      case "Success":
      case "PermanentFailure":
        return "Reachable";
      case "TransientFailure":
        return outcome.cause.kind === "Local" ? "Unknown" : "Unreachable";
    }
  },
  /** A short label for logs and metrics: `success`, `permanent`, or the transient cause. */
  label: (
    outcome: DeliveryAttemptOutcome,
  ): "success" | "permanent" | "http" | "throttled" | "network" | "local" => {
    switch (outcome.kind) {
      case "Success":
        return "success";
      case "PermanentFailure":
        return "permanent";
      case "TransientFailure":
        switch (outcome.cause.kind) {
          case "HttpStatus":
            return "http";
          case "Throttled":
            return "throttled";
          case "Network":
            return "network";
          case "Local":
            return "local";
        }
    }
  },
  /** The failing HTTP status, or 0 for a success or a failure without one. */
  failedHttpStatus: (outcome: DeliveryAttemptOutcome): number => {
    switch (outcome.kind) {
      case "Success":
        return 0;
      case "PermanentFailure":
        return outcome.httpStatus;
      case "TransientFailure":
        return outcome.cause.kind === "HttpStatus" || outcome.cause.kind === "Throttled"
          ? outcome.cause.httpStatus
          : 0;
    }
  },
} as const;
