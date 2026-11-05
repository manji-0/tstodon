import type { Context } from "hono";
import { jsonRepositoryError } from "../http";

/**
 * Why an API request is turned away: a Mastodon error body with its HTTP
 * status, or a storage failure (answered as `RepositoryError`, 500).
 */
export type ApiRefusal =
  | Readonly<{ kind: "Rejected"; status: 400 | 404 | 422; error: string; errorKind: string }>
  | Readonly<{ kind: "RepositoryFailed"; message: string }>;

export const ApiRefusal = {
  rejected: (status: 400 | 404 | 422, error: string, errorKind: string): ApiRefusal => ({
    kind: "Rejected",
    status,
    error,
    errorKind,
  }),
  /** Mastodon's answer for a status that is missing or that the viewer may not act on. */
  notFound: {
    kind: "Rejected",
    status: 404,
    error: "Record not found",
    errorKind: "NotFound",
  } as const satisfies ApiRefusal,
  repository: (message: string): ApiRefusal => ({ kind: "RepositoryFailed", message }),
  respond: (c: Context<{ Bindings: Env }>, refusal: ApiRefusal): Response =>
    refusal.kind === "Rejected"
      ? c.json({ error: refusal.error, kind: refusal.errorKind }, refusal.status)
      : jsonRepositoryError(c, refusal.message),
} as const;
