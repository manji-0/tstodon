import { Hono } from "hono";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { z } from "zod";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import { instanceRules } from "../runtime-config";
import { insertReport, ReportCategorySchema } from "../moderation-store";
import { stringList } from "../form-values";
import {
  FilterBodySchema,
  FilterKeywordBodySchema,
  FilterStatusBodySchema,
  FilterV2BodySchema,
} from "./filters";

export const reportRoutes = new Hono<{ Bindings: Env }>();

export const ReportBodySchema = z.object({
  account_id: z.string().min(1),
  status_ids: z.union([z.array(z.string()), z.string()]).optional(),
  comment: z.string().optional(),
  category: z.string().optional(),
  rule_ids: z
    .union([z.array(z.union([z.string(), z.number()])), z.string(), z.number()])
    .optional(),
});

reportRoutes.post("/api/v1/reports", async (c) => {
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
  const report = await insertReport(c.env.DB, {
    accountId: user.value.id,
    targetAccountId: body.value.account_id,
    statusIds: stringList(body.value.status_ids),
    comment: body.value.comment ?? "",
    category: category.value,
    ruleIds: requestedRules,
  });
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  return c.json({
    id: report.value.id,
    action_taken: false,
    action_taken_at: null,
    category: category.value,
    comment: body.value.comment ?? "",
    forwarded: false,
    status_ids: stringList(body.value.status_ids),
    rule_ids: requestedRules,
    target_account: { id: body.value.account_id },
  });
});

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([
  FilterBodySchema,
  FilterV2BodySchema,
  FilterKeywordBodySchema,
  FilterStatusBodySchema,
  ReportBodySchema,
]);
