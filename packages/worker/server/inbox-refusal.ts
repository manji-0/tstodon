import { Hostname } from "@tstodon/domain";
import { writeMetric } from "./metrics";

/**
 * Why the inbox refused a delivery. One `InboxRefused` log event and one
 * `inbox.refuse` metric point per refusal (OPS-5); see the runbook's log
 * event catalogue.
 */
export type InboxRefusalReason =
  /** 400: the body is not JSON, or not an activity. */
  | "UnparseableBody"
  /** 400: the activity's `id` is not a usable activity id. */
  | "InvalidActivityId"
  /** 400: the activity parsed but the inbox rejects it (`detail` says why). */
  | "ActivityRejected"
  /** 401: no `Signature` header, or one that does not parse. */
  | "MissingSignature"
  /** 401: `Digest` is missing or does not match the body. */
  | "DigestMismatch"
  /** 401: the activity names a local actor that does not exist. */
  | "UnknownLocalActor"
  /** 401: the key belongs to another actor than the activity's. */
  | "ActorMismatch"
  /** 401: the key could not be used: its document was refused, gone, or not an actor's key. */
  | "KeyRejected"
  /** 401: the signature does not verify with the signer's key. */
  | "SignatureMismatch"
  /** 503: the key's server did not answer (`Retry-After` sent). */
  | "KeyUnavailable"
  /** 403: the signer's domain is suspended here. */
  | "DomainSuspended"
  /** 403: limited federation, and the signer's domain is not allowed. */
  | "DomainNotAllowed"
  /** 403: an admin suspended the signing actor. */
  | "ActorSuspended"
  /** 429: the signing server is over its `inbox_domain` limit. */
  | "RateLimitedDomain"
  /** 429: the client address is over its `inbox_ip` limit. */
  | "RateLimitedAddress";

export type InboxRefusal = Readonly<{
  reason: InboxRefusalReason;
  status: 400 | 401 | 403 | 429 | 503;
  path: string;
  /** The `Signature` header's `keyId`, when there is one. Only its host is logged. */
  keyId?: string | undefined;
  /** The activity's `actor`, as the sender claims it. */
  actor?: string | undefined;
  /** The verified signer, once known. */
  signer?: string | undefined;
  /** A short machine-readable detail (the rejection's `kind`). */
  detail?: string | undefined;
}>;

/** Log lines per reason per window, per isolate; the rest are only counted. */
export const INBOX_REFUSAL_LOG_LIMIT = 5;
export const INBOX_REFUSAL_WINDOW_MS = 60_000;

/** URIs are the sender's own strings: cut them short before logging. */
const MAX_URI_LENGTH = 200;

const clip = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.slice(0, MAX_URI_LENGTH);

type Window = { startedAt: number; logged: number; suppressed: number };

export type RefusalSampler = Readonly<{
  /**
   * Whether this refusal is logged, and how many of its reason the window
   * before this one left unlogged (reported once, by the first refusal of a
   * new window).
   */
  admit: (reason: InboxRefusalReason) => Readonly<{ log: boolean; suppressedBefore: number }>;
}>;

/**
 * Up to `limit` log lines per reason in each `windowMs` window; a flood of
 * one reason does not hide the others, and costs `limit` lines a minute.
 */
export const createRefusalSampler = (
  limit: number = INBOX_REFUSAL_LOG_LIMIT,
  windowMs: number = INBOX_REFUSAL_WINDOW_MS,
  now: () => number = Date.now,
): RefusalSampler => {
  const windows = new Map<InboxRefusalReason, Window>();
  return {
    admit: (reason) => {
      const at = now();
      let window = windows.get(reason);
      let suppressedBefore = 0;
      if (window === undefined || at - window.startedAt >= windowMs) {
        suppressedBefore = window?.suppressed ?? 0;
        window = { startedAt: at, logged: 0, suppressed: 0 };
        windows.set(reason, window);
      }
      if (window.logged < limit) {
        window.logged += 1;
        return { log: true, suppressedBefore };
      }
      window.suppressed += 1;
      return { log: false, suppressedBefore };
    },
  };
};

let isolateSampler = createRefusalSampler();

/** Start every reason's window afresh (tests). */
export const forgetInboxRefusalWindows = (): void => {
  isolateSampler = createRefusalSampler();
};

/**
 * Record one inbox refusal: always an `inbox.refuse` point (doubles
 * `[1, loggedFlag]`, blobs `[reason, status]`), and an `InboxRefused` warn
 * line unless this isolate already logged {@link INBOX_REFUSAL_LOG_LIMIT} of
 * the reason this minute. The first line of a new window is preceded by
 * `InboxRefusalsSuppressed` with the count the last window left unlogged.
 * No body, header value or key material is logged: the key's host, the
 * claimed actor and the verified signer (clipped URIs), and the path.
 */
export const recordInboxRefusal = (
  env: Env,
  refusal: InboxRefusal,
  sampler: RefusalSampler = isolateSampler,
): void => {
  const { log, suppressedBefore } = sampler.admit(refusal.reason);
  writeMetric(env, "inbox.refuse", [1, log ? 1 : 0], [refusal.reason, String(refusal.status)]);
  if (suppressedBefore > 0) {
    console.warn(
      JSON.stringify({
        kind: "InboxRefusalsSuppressed",
        reason: refusal.reason,
        suppressed: suppressedBefore,
      }),
    );
  }
  if (!log) {
    return;
  }
  console.warn(
    JSON.stringify({
      kind: "InboxRefused",
      reason: refusal.reason,
      status: refusal.status,
      path: refusal.path,
      keyIdHost: refusal.keyId === undefined ? undefined : (Hostname.ofUri(refusal.keyId) ?? ""),
      actor: clip(refusal.actor),
      signer: clip(refusal.signer),
      detail: refusal.detail,
    }),
  );
};
