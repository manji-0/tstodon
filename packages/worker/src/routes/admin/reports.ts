import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type { InstanceIdentity } from "@tstodon/domain";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readBody,
  requireAdmin,
} from "../../http";
import { mastodonStatuses } from "../../local-status-documents";
import { instanceRules, parseInstanceIdentity } from "../../runtime-config";
import { ReportCategorySchema, type ReportRow } from "../../moderation-store";
import {
  findReportById,
  listReports,
  setReportAssigned,
  setReportResolved,
  updateReport,
} from "../../moderation-store";
import { findStatusesByIds } from "../../status-store";
import { schemaResult } from "@tstodon/core";
import { adminAccountFor } from "./accounts";

export const adminReportRoutes = new Hono<{ Bindings: Env }>();

const adminReportDocument = async (
  c: Context<{ Bindings: Env }>,
  identity: InstanceIdentity,
  report: ReportRow,
): Promise<Record<string, unknown>> => {
  const reported = await findStatusesByIds(c.env.DB, [...report.statusIds]);
  const statuses =
    reported.isOk() && reported.value.size > 0
      ? await mastodonStatuses(c.env, identity, [...reported.value.values()], undefined)
      : [];
  return {
    id: report.id,
    action_taken: report.actionTakenAt !== null,
    action_taken_at: report.actionTakenAt,
    category: report.category,
    comment: report.comment,
    forwarded: false,
    created_at: report.createdAt,
    updated_at: report.updatedAt ?? report.createdAt,
    account: await adminAccountFor(c.env, identity, report.accountId),
    target_account: await adminAccountFor(c.env, identity, report.targetAccountId),
    assigned_account: report.assignedAccountId
      ? await adminAccountFor(c.env, identity, report.assignedAccountId)
      : null,
    action_taken_by_account: report.actionTakenByAccountId
      ? await adminAccountFor(c.env, identity, report.actionTakenByAccountId)
      : null,
    statuses,
    // The configured rules this violation is tied to.
    rules: instanceRules(c.env)
      .filter((rule) => report.ruleIds.includes(rule.id))
      .map((rule) =>
        rule.hint === undefined
          ? { id: rule.id, text: rule.text }
          : { id: rule.id, text: rule.text, hint: rule.hint },
      ),
  };
};

/** Boolean report filters: `resolved=false` narrows to open reports. */
const reportResolvedFilter = (c: Context<{ Bindings: Env }>): boolean | undefined => {
  const raw = (c.req.query("resolved") ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1") {
    return true;
  }
  if (raw === "false" || raw === "0") {
    return false;
  }
  return undefined;
};

adminReportRoutes.get("/api/v1/admin/reports", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const reports = await listReports(c.env.DB, {
    resolved: reportResolvedFilter(c),
    accountId: c.req.query("account_id") || undefined,
    targetAccountId: c.req.query("target_account_id") || undefined,
    cursor: queryCursor(c),
    limit: queryAdminLimit(c.req.query("limit")),
  });
  if (reports.isErr()) {
    return jsonRepositoryError(c, reports.error.message);
  }
  const documents: Record<string, unknown>[] = [];
  for (const report of reports.value) {
    documents.push(await adminReportDocument(c, identity.value, report));
  }
  return c.json(documents);
});

adminReportRoutes.get("/api/v1/admin/reports/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const report = await findReportById(c.env.DB, c.req.param("id") ?? "");
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (!report.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, report.value));
});

const ReportUpdateBodySchema = z.object({
  category: z.string().optional(),
  rule_ids: z
    .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
    .optional(),
});

/** `rule_ids` accepts both the array and the `rule_ids[]` form. */
const reportRuleIds = (body: z.infer<typeof ReportUpdateBodySchema>, raw: unknown): string[] => {
  const collected: string[] = [];
  for (const source of [body.rule_ids, raw]) {
    if (Array.isArray(source)) {
      collected.push(...source.map((value) => String(value).trim()));
    } else if (typeof source === "string" || typeof source === "number") {
      collected.push(String(source).trim());
    }
  }
  return [...new Set(collected)].filter((value) => value.length > 0);
};

/**
 * `PUT /api/v1/admin/reports/:id` changes the category and, for a `violation`,
 * the configured rules it broke. Rules are the `INSTANCE_RULES` entries with
 * their 1-based ids, so an id this instance does not have is refused.
 */
adminReportRoutes.put("/api/v1/admin/reports/:id", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, ReportUpdateBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const rawRuleIds = c.req.queries("rule_ids[]") ?? c.req.queries("rule_ids") ?? [];
  const reported = await findReportById(c.env.DB, c.req.param("id") ?? "");
  if (reported.isErr()) {
    return jsonRepositoryError(c, reported.error.message);
  }
  if (!reported.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const category =
    body.value.category === undefined ? reported.value.category : body.value.category.trim();
  if (schemaResult(ReportCategorySchema)(category).isErr()) {
    return c.json(
      { error: "Validation failed: Category is not included in the list", kind: "ValidationError" },
      422,
    );
  }
  const providedRules = [...reportRuleIds(body.value, undefined), ...rawRuleIds];
  const uniqueRules = [...new Set(providedRules)];
  if (uniqueRules.length > 0 && category !== "violation") {
    return c.json(
      { error: "Validation failed: Rule ids must be blank", kind: "ValidationError" },
      422,
    );
  }
  // Mastodon validates `rule_ids` on any category change: leaving `violation`
  // without clearing them is refused, so rules never linger on a report that is
  // no longer a violation.
  const changedCategory = category !== reported.value.category;
  const rulesProvided = body.value.rule_ids !== undefined || rawRuleIds.length > 0;
  if (
    changedCategory &&
    category !== "violation" &&
    !rulesProvided &&
    reported.value.ruleIds.length > 0
  ) {
    return c.json(
      { error: "Validation failed: Rule ids must be blank", kind: "ValidationError" },
      422,
    );
  }
  const known = new Set(instanceRules(c.env).map((rule) => rule.id));
  if (uniqueRules.some((id) => !known.has(id))) {
    return c.json(
      { error: "Validation failed: Rule ids are invalid", kind: "ValidationError" },
      422,
    );
  }
  const changed = await updateReport(c.env.DB, reported.value.id, {
    category,
    ruleIds: body.value.rule_ids === undefined && rawRuleIds.length === 0 ? undefined : uniqueRules,
  });
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const updated = await findReportById(c.env.DB, reported.value.id);
  if (updated.isErr() || !updated.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, updated.value));
});

/** Assign (`assign_to_self`) or unassign (`unassign`) a report. */
const assignReport = async (c: Context<{ Bindings: Env }>, assigned: boolean) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const changed = await setReportAssigned(c.env.DB, id, assigned ? admin.value.account.id : null);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const report = await findReportById(c.env.DB, id);
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (!report.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, report.value));
};

adminReportRoutes.post("/api/v1/admin/reports/:id/assign_to_self", (c) => assignReport(c, true));
adminReportRoutes.post("/api/v1/admin/reports/:id/unassign", (c) => assignReport(c, false));

/** Resolve (`resolve`) or reopen (`reopen`) a report. */
const resolveReport = async (c: Context<{ Bindings: Env }>, resolved: boolean) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const changed = await setReportResolved(c.env.DB, id, resolved ? admin.value.account.id : null);
  if (changed.isErr()) {
    return jsonRepositoryError(c, changed.error.message);
  }
  const report = await findReportById(c.env.DB, id);
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (!report.value) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  return c.json(await adminReportDocument(c, identity.value, report.value));
};

adminReportRoutes.post("/api/v1/admin/reports/:id/resolve", (c) => resolveReport(c, true));
adminReportRoutes.post("/api/v1/admin/reports/:id/reopen", (c) => resolveReport(c, false));

/** Canonical email blocks: a hash of the mailbox, so respellings stay blocked. */
