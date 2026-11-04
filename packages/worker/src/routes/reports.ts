import type { Context } from "hono";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { notifyAdmins } from "../admin-notify";
import { instanceRules, parseInstanceIdentity } from "../runtime-config";
import type { LocalAccount, RemoteActor } from "@tstodon/domain";
import { forwardReport } from "../report-forward";
import type { Result } from "neverthrow";
import { findAccountById } from "../account-store";
import type { RepositoryError } from "../d1";
import { findRemoteActorByUri } from "../remote-actor-store";
import { reportedStatuses } from "../report-documents";
import { insertReport, ReportCategorySchema, ReportParty } from "../report-store";
import { booleanish, isTruthy, stringList } from "../form-values";

export const ReportBodySchema = z.object({
  account_id: z.string().min(1),
  status_ids: z.union([z.array(z.string()), z.string()]).optional(),
  comment: z.string().optional(),
  category: z.string().optional(),
  rule_ids: z
    .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
    .optional(),
  /** Forward a report on a remote account to its server. */
  forward: booleanish,
});

export const postV1Reports = async (c: Context<{ Bindings: Env }, "/api/v1/reports">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, ReportBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const requestedCategory = (body.value.category ?? "other").trim().toLowerCase();
  const category = schemaResult(ReportCategorySchema)(requestedCategory);
  if (category.isErr()) {
    return c.json(
      { error: "Validation failed: Category is not included in the list", kind: "ValidationError" },
      422,
    );
  }
  // Rule ids are the configured `INSTANCE_RULES` entries, and Mastodon keeps
  // them for `violation` reports only.
  const rawRuleIds = body.value.rule_ids;
  const requestedRules = (
    Array.isArray(rawRuleIds)
      ? rawRuleIds.map((value) => String(value).trim())
      : typeof rawRuleIds === "string" || typeof rawRuleIds === "number"
        ? [String(rawRuleIds).trim()]
        : []
  ).filter((value) => value.length > 0);
  const knownRules = new Set(instanceRules(c.env).map((rule) => rule.id));
  if (requestedRules.length > 0 && category.value !== "violation") {
    return c.json(
      { error: "Validation failed: Rule ids must be blank", kind: "ValidationError" },
      422,
    );
  }
  if (requestedRules.some((id) => !knownRules.has(id))) {
    return c.json(
      { error: "Validation failed: Rule ids are invalid", kind: "ValidationError" },
      422,
    );
  }
  const target = await findReportTarget(c.env.DB, body.value.account_id);
  if (target.isErr()) {
    return jsonRepositoryError(c, target.error.message);
  }
  if (!target.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const party = ReportParty.ofAccountId(body.value.account_id);
  const statuses = await targetStatuses(c.env.DB, party, stringList(body.value.status_ids));
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const statusIds = statuses.value.map((status) => status.id);
  // A local account's report stays here, whatever `forward` says.
  const forwardTo =
    isTruthy(body.value.forward) && target.value.kind === "Remote" ? target.value.actor : undefined;
  const comment = body.value.comment ?? "";
  const report = await insertReport(c.env.DB, {
    reporter: { kind: "Local", accountId: user.value.id },
    target: party,
    statusIds,
    comment,
    category: category.value,
    ruleIds: requestedRules,
    forwarded: forwardTo !== undefined,
  });
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (report.value.kind === "AlreadyFiled") {
    return jsonRepositoryError(c, "report without a Flag was already filed");
  }
  if (forwardTo !== undefined) {
    const forwarded = await forwardReport(c.env, identity.value, {
      id: report.value.id,
      target: forwardTo,
      comment,
      statusUris: statuses.value.flatMap((status) =>
        status.objectUri === undefined ? [] : [status.objectUri],
      ),
    });
    if (forwarded.isErr()) {
      console.error(
        JSON.stringify({
          kind: "ReportForwardFailed",
          reportId: report.value.id,
          error: forwarded.error,
        }),
      );
    }
  }
  // A failed notification must not lose the filed report.
  await notifyAdmins(c.env, {
    kind: "admin.report",
    fromAccountId: user.value.id,
    reportId: report.value.id,
  });
  return c.json({
    id: report.value.id,
    action_taken: false,
    action_taken_at: null,
    category: category.value,
    comment: body.value.comment ?? "",
    forwarded: forwardTo !== undefined,
    status_ids: statusIds,
    rule_ids: requestedRules,
    target_account: { id: body.value.account_id },
  });
};

type ReportTarget =
  | Readonly<{ kind: "Local"; account: LocalAccount }>
  | Readonly<{ kind: "Remote"; actor: RemoteActor }>;

const findReportTarget = async (
  db: D1Database,
  accountId: string,
): Promise<Result<ReportTarget | undefined, RepositoryError>> => {
  const party = ReportParty.ofAccountId(accountId);
  if (party.kind === "Local") {
    const account = await findAccountById(db, party.accountId);
    return account.map((found) => (found ? { kind: "Local", account: found } : undefined));
  }
  const actor = await findRemoteActorByUri(db, party.actorUri);
  return actor.map((found) => (found ? { kind: "Remote", actor: found } : undefined));
};

/** A post kept on a report; a remote one carries its ActivityPub id. */
type TargetStatus = Readonly<{ id: string; objectUri?: string }>;

/** As Mastodon's `ReportService`: only the target's own posts stay attached, in request order. */
const targetStatuses = async (
  db: D1Database,
  target: ReportParty,
  requested: ReadonlyArray<string>,
): Promise<Result<ReadonlyArray<TargetStatus>, RepositoryError>> => {
  const statuses = await reportedStatuses(db, requested);
  return statuses.map(({ local, remote }) => {
    const owned = new Map<string, TargetStatus>(
      target.kind === "Local"
        ? local
            .filter((status) => status.accountId === target.accountId)
            .map((status) => [status.id, { id: status.id }])
        : remote
            .filter(({ status }) => status.actorUri === target.actorUri)
            .map(({ status }) => [status.id, { id: status.id, objectUri: status.objectUri }]),
    );
    return [...new Set(requested)].flatMap((id) => {
      const status = owned.get(id);
      return status ? [status] : [];
    });
  });
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([ReportBodySchema]);
