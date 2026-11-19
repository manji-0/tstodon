import { type ApiStatusJSON, ApiUpdateStatusInteractionPolicyParamsSchema } from "@tstodon/api";
import { warmSchemas } from "@tstodon/core";
import type { InstanceIdentity, LocalAccount, LocalNote } from "@tstodon/domain";
import type { Context } from "hono";
import { err, type Result } from "neverthrow";
import { authenticate } from "../../auth";
import { nowIso } from "../../clock";
import { type RepositoryError, toRepositoryError } from "../../d1";
import { findShownStatusAnywhere } from "../../found-status";
import { jsonAuthError, jsonRepositoryError, jsonValidationError } from "../../http";
import { mastodonStatus } from "../../local-status-documents";
import { announceNoteUpdate } from "../../local-status-update";
import { noteQuotePolicy, quotePolicyName } from "../../quote-policy-name";
import { visibilityIsPublic } from "../../quote-resolve";
import {
  findStatusQuotePolicy,
  isQuotePolicy,
  type QuotePolicy,
  setStatusQuotePolicy,
} from "../../quote-store";
import { readMergedParams } from "../../request-params";
import { parseInstanceIdentity } from "../../runtime-config";

/**
 * Store the note's new policy and, when that changes the policy it goes by,
 * tell local streams and remote servers with an `Update` that is not an edit,
 * as Mastodon's `broadcast_updates!`. A note that is not public or unlisted
 * stays the author's alone to quote (`downgrade_quote_policy`), so it never
 * changes. Answers the note as it now reads.
 */
const applyQuotePolicy = async (
  env: Env,
  identity: InstanceIdentity,
  author: LocalAccount,
  note: LocalNote,
  requested: QuotePolicy,
): Promise<Result<ApiStatusJSON | undefined, RepositoryError>> => {
  const stored = await findStatusQuotePolicy(env.DB, note.id);
  if (stored.isErr()) {
    return err(stored.error);
  }
  const next = visibilityIsPublic(note.visibility) ? requested : "nobody";
  const changed = noteQuotePolicy(author, note, stored.value) !== next;
  if (stored.value !== next) {
    const saved = await setStatusQuotePolicy(env.DB, note.id, next);
    if (saved.isErr()) {
      return err(saved.error);
    }
  }
  if (!changed) {
    return mastodonStatus(env, identity, note, author.id);
  }
  const announced = await announceNoteUpdate(
    env,
    identity,
    author,
    note,
    nowIso(),
    true,
    "Unedited",
  );
  return announced.mapErr((error) =>
    toRepositoryError(error.kind === "InvalidActivityId" ? "invalid activity id" : error.message),
  );
};

/**
 * `PUT /api/v1/statuses/:id/interaction_policy`, as Mastodon v4.7.5's
 * `Api::V1::Statuses::InteractionPoliciesController`: the author changes a
 * published status's quote policy. A status the viewer cannot see answers
 * 404, and one the viewer did not write 403. A blank or missing
 * `quote_approval_policy` takes the author's default; one Mastodon does not
 * know answers 422 "Record invalid", as its `ActiveRecord::RecordInvalid`.
 */
export const putV1StatusesByIdInteractionPolicy = async (
  c: Context<{ Bindings: Env }, "/api/v1/statuses/:id/interaction_policy">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const auth = await authenticate(c.req.raw, c.env);
  if (auth.isErr()) {
    return jsonAuthError(c, auth.error);
  }
  if (auth.value.kind === "Anonymous") {
    return jsonAuthError(c, { kind: "MissingToken" });
  }
  const viewer = auth.value.kind === "Account" ? auth.value.account : undefined;
  const found = await findShownStatusAnywhere(c.env, c.req.param("id"), viewer?.id);
  if (found.isErr()) {
    return jsonRepositoryError(c, found.error.message);
  }
  if (!found.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  if (
    viewer === undefined ||
    found.value.kind !== "LocalStatus" ||
    found.value.status.accountId !== viewer.id
  ) {
    return c.json({ error: "This action is not allowed", kind: "Forbidden" }, 403);
  }
  const params = await readMergedParams(c, ApiUpdateStatusInteractionPolicyParamsSchema);
  if (params.isErr()) {
    return jsonValidationError(c);
  }
  const raw = params.value.quote_approval_policy ?? "";
  if (raw.trim() !== "" && !isQuotePolicy(raw)) {
    return c.json({ error: "Record invalid" }, 422);
  }
  const requested = isQuotePolicy(raw) ? raw : quotePolicyName(viewer.defaultQuotePolicy);
  const status = found.value.status;
  // A boost has no quote policy of its own to change.
  const rendered =
    status.kind === "LocalNote"
      ? await applyQuotePolicy(c.env, identity.value, viewer, status, requested)
      : await mastodonStatus(c.env, identity.value, status, viewer.id);
  if (rendered.isErr()) {
    return jsonRepositoryError(c, rendered.error.message);
  }
  return rendered.value
    ? c.json(rendered.value)
    : c.json({ error: "Record not found", kind: "NotFound" }, 404);
};

warmSchemas([ApiUpdateStatusInteractionPolicyParamsSchema]);
