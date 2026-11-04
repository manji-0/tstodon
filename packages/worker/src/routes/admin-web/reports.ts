import { schemaResult, warmSchemas } from "@tstodon/core";
import type { LocalStatusValue } from "@tstodon/domain";
import type { Context } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  AccountActionTypeSchema,
  findAdminAccount,
  findAdminRemoteActor,
  takeAccountAction,
} from "../../admin-actions";
import {
  confirmPage,
  moderationSummary,
  REMOTE_REPORT_ACTIONS,
  remoteModerationSummary,
  REPORT_ACTIONS,
  type ReportDetails,
  reportPage,
  reportsPage,
  type ReportSummary,
} from "../../admin-pages";
import { errorPage } from "../../auth-pages";
import type { RepositoryError } from "../../d1";
import {
  findReportById,
  listReports,
  ReportParty,
  type ReportRow,
  setReportAssigned,
  setReportResolved,
} from "../../report-store";
import { instanceRules } from "../../runtime-config";
import { reportedStatuses } from "../../report-documents";
import { summaryText } from "../../remote-actor-fetch";
import { instanceName } from "../account-settings";
import {
  accountLabeller,
  adminSession,
  badForm,
  notFound,
  type NoticeKey,
  noticeOf,
  readFields,
  serverError,
  withNotice,
} from "./shared";
import { pageRedirect } from "../../page-redirect";

/** Mastodon's `/admin/reports` page and the moderation it offers on a report. */

const REPORTS_PER_PAGE = 50;

const summaryOf = async (
  label: ReturnType<typeof accountLabeller>,
  report: ReportRow,
): Promise<ReportSummary> => ({
  id: report.id,
  reporter: await label(ReportParty.accountId(report.reporter), report.reporterAcct),
  target: await label(ReportParty.accountId(report.target), report.targetAcct),
  category: report.category,
  comment: report.comment,
  statusCount: report.statusIds.length,
  assignee: report.assignedAccountId === null ? undefined : await label(report.assignedAccountId),
  resolved: report.actionTakenAt !== null,
  createdAt: report.createdAt,
});

/** Mastodon's `GET /admin/reports`. */
export const getAdminReports = async (c: Context<{ Bindings: Env }, "/admin/reports">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const resolved = c.req.query("resolved") === "1";
  const reports = await listReports(c.env.DB, {
    resolved,
    cursor: { maxId: c.req.query("max_id") },
    limit: REPORTS_PER_PAGE,
  });
  if (reports.isErr()) {
    return serverError(c, reports.error);
  }
  const label = accountLabeller(c.env.DB);
  const summaries = await Promise.all(reports.value.map((report) => summaryOf(label, report)));
  const last = reports.value.at(-1);
  const olderHref =
    reports.value.length < REPORTS_PER_PAGE || last === undefined
      ? undefined
      : `/admin/reports?${new URLSearchParams({ ...(resolved ? { resolved: "1" } : {}), max_id: last.id }).toString()}`;
  return c.html(
    reportsPage(instanceName(c.env), { resolved, reports: summaries, olderHref }, noticeOf(c)),
  );
};

const statusText = (status: LocalStatusValue): string => {
  switch (status.kind) {
    case "LocalNote":
      return status.spoilerText.length === 0
        ? status.text
        : `Content warning: ${status.spoilerText}\n${status.text}`;
    case "LocalReblog":
      return `Boost of post ${status.target.statusId}`;
  }
};

/** What the report page says of its target and offers on it; `undefined` when the target is gone. */
const targetModerationOf = async (
  db: D1Database,
  target: ReportParty,
): Promise<ReportDetails["targetModeration"]> => {
  if (target.kind === "Local") {
    const state = await findAdminAccount(db, target.accountId);
    return state.isOk() && state.value
      ? { summary: moderationSummary(state.value), actions: REPORT_ACTIONS }
      : undefined;
  }
  const state = await findAdminRemoteActor(db, target.actorUri);
  return state.isOk() && state.value
    ? { summary: remoteModerationSummary(state.value.moderation), actions: REMOTE_REPORT_ACTIONS }
    : undefined;
};

/** Mastodon's `GET /admin/reports/:id`. */
export const getAdminReport = async (c: Context<{ Bindings: Env }, "/admin/reports/:id">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const report = await findReportById(c.env.DB, c.req.param("id"));
  if (report.isErr()) {
    return serverError(c, report.error);
  }
  if (!report.value) {
    return notFound(c, "report");
  }
  const row = report.value;
  const label = accountLabeller(c.env.DB);
  const [summary, statuses, targetModeration, actionTakenBy] = await Promise.all([
    summaryOf(label, row),
    reportedStatuses(c.env.DB, row.statusIds),
    targetModerationOf(c.env.DB, row.target),
    row.actionTakenByAccountId === null ? undefined : label(row.actionTakenByAccountId),
  ]);
  const details: ReportDetails = {
    ...summary,
    statuses: statuses.isOk()
      ? [
          ...statuses.value.local.map((status) => ({
            id: status.id,
            text: statusText(status),
            createdAt: status.createdAt,
          })),
          ...statuses.value.remote.map(({ status }) => ({
            id: status.id,
            text: summaryText(status.contentHtml),
            createdAt: status.publishedAt,
          })),
        ]
      : [],
    rules: instanceRules(c.env)
      .filter((rule) => row.ruleIds.includes(rule.id))
      .map((rule) => rule.text),
    actionTakenBy,
    actionTakenAt: row.actionTakenAt,
    targetModeration,
    assignedToViewer: row.assignedAccountId === admin.account.id,
  };
  return c.html(reportPage(instanceName(c.env), details, noticeOf(c)));
};

const ReportCommandSchema = z.union([
  z.literal("resolve"),
  z.literal("reopen"),
  z.literal("assign_to_self"),
  z.literal("unassign"),
]);

type ReportCommand = z.infer<typeof ReportCommandSchema>;

const runReportCommand = (
  db: D1Database,
  reportId: string,
  adminId: string,
  command: ReportCommand,
): Promise<Result<boolean, RepositoryError>> => {
  switch (command) {
    case "resolve":
      return setReportResolved(db, reportId, adminId);
    case "reopen":
      return setReportResolved(db, reportId, null);
    case "assign_to_self":
      return setReportAssigned(db, reportId, adminId);
    case "unassign":
      return setReportAssigned(db, reportId, null);
  }
};

const REPORT_NOTICES = {
  resolve: "resolved",
  reopen: "reopened",
  assign_to_self: "assigned",
  unassign: "unassigned",
} as const satisfies Record<ReportCommand, NoticeKey>;

/** The report page's resolve, reopen, and assignment buttons. */
export const postAdminReport = async (c: Context<{ Bindings: Env }, "/admin/reports/:id">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const command = schemaResult(ReportCommandSchema)((await readFields(c)).do);
  if (command.isErr()) {
    return badForm(c);
  }
  const id = c.req.param("id");
  const changed = await runReportCommand(c.env.DB, id, admin.account.id, command.value);
  if (changed.isErr()) {
    return serverError(c, changed.error);
  }
  return changed.value
    ? pageRedirect(c, withNotice(`/admin/reports/${id}`, REPORT_NOTICES[command.value]), 303)
    : notFound(c, "report");
};

/**
 * A moderation action on the reported account, through the same code as
 * `POST /api/v1/admin/accounts/:id/action`; it resolves this report.
 * Suspending asks again first.
 */
export const postAdminReportAction = async (
  c: Context<{ Bindings: Env }, "/admin/reports/:id/action">,
) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const fields = await readFields(c);
  const type = schemaResult(AccountActionTypeSchema)(fields.type);
  if (type.isErr()) {
    return badForm(c);
  }
  const id = c.req.param("id");
  const report = await findReportById(c.env.DB, id);
  if (report.isErr()) {
    return serverError(c, report.error);
  }
  if (!report.value) {
    return notFound(c, "report");
  }
  const back = `/admin/reports/${id}`;
  const reported = report.value.target;
  const reportedId = ReportParty.accountId(reported);
  if (reported.kind === "Local" && reported.accountId === admin.account.id) {
    return c.html(errorPage(instanceName(c.env), "You cannot moderate your own account."), 422);
  }
  if (type.value === "suspend" && fields.confirmed !== "1") {
    const target = await accountLabeller(c.env.DB)(reportedId, report.value.targetAcct);
    return c.html(
      confirmPage(instanceName(c.env), {
        title: `Suspend ${target.label}?`,
        text: "Suspending hides the account and its posts and refuses what it sends. You can lift it later from the account's page.",
        action: `${back}/action`,
        fields: { type: "suspend" },
        confirmLabel: "Suspend",
        cancelHref: back,
      }),
    );
  }
  const taken = await takeAccountAction(c.env.DB, {
    accountId: reportedId,
    type: type.value,
    reportId: report.value.id,
    moderatorId: admin.account.id,
  });
  if (taken.isOk()) {
    return pageRedirect(c, withNotice(back, "actioned"), 303);
  }
  switch (taken.error.kind) {
    case "AccountNotFound":
      return c.html(
        errorPage(instanceName(c.env), "This server no longer has the reported account."),
        422,
      );
    case "NotApplicable":
      return c.html(
        errorPage(instanceName(c.env), "That action does not apply to a remote account."),
        422,
      );
    case "ReportNotFound":
      return notFound(c, "report");
    case "RepositoryError":
      return serverError(c, taken.error);
  }
};

warmSchemas([ReportCommandSchema, AccountActionTypeSchema]);
