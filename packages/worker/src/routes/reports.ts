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
import { instanceRules } from "../runtime-config";
import type { Result } from "neverthrow";
import { findAccountById } from "../account-store";
import type { RepositoryError } from "../d1";
import { findRemoteActorByUri } from "../remote-actor-store";
import { reportedStatuses } from "../report-documents";
import { insertReport, ReportCategorySchema, ReportParty } from "../report-store";
import { stringList } from "../form-values";

export const ReportBodySchema = z.object({
  account_id: z.string().min(1),
  status_ids: z.union([z.array(z.string()), z.string()]).optional(),
  comment: z.string().optional(),
  category: z.string().optional(),
  rule_ids: z
    .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
    .optional(),
});

export const postV1Reports = async (c: Context<{ Bindings: Env }, "/api/v1/reports">) => {
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
  const target = ReportParty.ofAccountId(body.value.account_id);
  const known = await reportTargetExists(c.env.DB, target);
  if (known.isErr()) {
    return jsonRepositoryError(c, known.error.message);
  }
  if (!known.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const statusIds = await targetStatusIds(c.env.DB, target, stringList(body.value.status_ids));
  if (statusIds.isErr()) {
    return jsonRepositoryError(c, statusIds.error.message);
  }
  const report = await insertReport(c.env.DB, {
    reporter: { kind: "Local", accountId: user.value.id },
    target,
    statusIds: statusIds.value,
    comment: body.value.comment ?? "",
    category: category.value,
    ruleIds: requestedRules,
  });
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (report.value.kind === "AlreadyFiled") {
    return jsonRepositoryError(c, "report without a Flag was already filed");
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
    forwarded: false,
    status_ids: statusIds.value,
    rule_ids: requestedRules,
    target_account: { id: body.value.account_id },
  });
};

const reportTargetExists = async (
  db: D1Database,
  target: ReportParty,
): Promise<Result<boolean, RepositoryError>> => {
  const found =
    target.kind === "Local"
      ? await findAccountById(db, target.accountId)
      : await findRemoteActorByUri(db, target.actorUri);
  return found.map((value) => value !== undefined);
};

/** As Mastodon's `ReportService`: only the target's own posts stay attached. */
const targetStatusIds = async (
  db: D1Database,
  target: ReportParty,
  requested: ReadonlyArray<string>,
): Promise<Result<ReadonlyArray<string>, RepositoryError>> => {
  const statuses = await reportedStatuses(db, requested);
  return statuses.map(({ local, remote }) => {
    const owned = new Set<string>(
      target.kind === "Local"
        ? local.filter((status) => status.accountId === target.accountId).map((status) => status.id)
        : remote
            .filter(({ status }) => status.actorUri === target.actorUri)
            .map(({ status }) => status.id),
    );
    return [...new Set(requested)].filter((id) => owned.has(id));
  });
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([ReportBodySchema]);
