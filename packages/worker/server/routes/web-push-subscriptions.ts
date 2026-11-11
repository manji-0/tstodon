import type { Context } from "hono";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { AuthenticatedSession } from "../auth";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readNestedBody,
  requireSession,
} from "../http";
import { findTokenPushSubscription } from "../push-subscription-store";
import { WEB_APP_ID } from "../web-token";
import {
  createPushSubscription,
  notFound,
  PushCreateBodySchema,
  PushDataSchema,
  updatePushSubscription,
} from "./push";

/**
 * Mastodon's `Api::Web::PushSubscriptionsController`: the web UI's Web Push
 * subscription. Mastodon ties it to the browser session; here that is the
 * session's web app access token (`web:<session id>`, `server/web-app.ts`),
 * which the UI sends as its bearer token, so the subscription is stored as
 * the REST one is and the initial state reports it (`push_subscription`).
 * Other apps subscribe through `/api/v1/push/subscription`.
 */

const WebPushUpdateBodySchema = z.object({ data: PushDataSchema });

/** The signed-in web UI: the session's web app token, and no other app's. */
const requireWebSession = async (
  c: Context<{ Bindings: Env }>,
): Promise<Result<AuthenticatedSession, Response>> => {
  const session = await requireSession(c);
  if (session.isErr()) {
    return err(jsonAuthError(c, session.error));
  }
  if (session.value.token.applicationId !== WEB_APP_ID) {
    return err(
      c.json(
        { error: "This method requires an authenticated user session", kind: "Forbidden" },
        403,
      ),
    );
  }
  return ok(session.value);
};

/** `POST /api/web/push_subscriptions`: replaces the session's subscription. */
export const postApiWebPushSubscriptions = async (
  c: Context<{ Bindings: Env }, "/api/web/push_subscriptions">,
) => {
  const session = await requireWebSession(c);
  if (session.isErr()) {
    return session.error;
  }
  const body = await readNestedBody(c, PushCreateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  return createPushSubscription(c, session.value, body.value);
};

/**
 * `PUT /api/web/push_subscriptions/:id`: new alerts and policy for the
 * session's subscription, which `:id` must name.
 */
export const putApiWebPushSubscription = async (
  c: Context<{ Bindings: Env }, "/api/web/push_subscriptions/:id">,
) => {
  const session = await requireWebSession(c);
  if (session.isErr()) {
    return session.error;
  }
  const body = await readNestedBody(c, WebPushUpdateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const current = await findTokenPushSubscription(c.env.DB, session.value.token.id);
  if (current.isErr()) {
    return jsonRepositoryError(c, current.error.message);
  }
  if (!current.value || String(current.value.id) !== c.req.param("id")) {
    return notFound(c);
  }
  return updatePushSubscription(c, session.value, body.value.data, body.value.data.policy);
};
