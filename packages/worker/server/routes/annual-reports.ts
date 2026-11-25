import type { ApiAnnualReportStateJSON } from "@tstodon/api";
import { annualReportCampaign, type LocalAccount } from "@tstodon/domain";
import type { Context } from "hono";
import { annualReportsDocument } from "../annual-report-documents";
import { queueAnnualReportGeneration } from "../annual-report-generation";
import {
  type AnnualReport,
  annualReportState,
  findAnnualReport,
  findAnnualReportRefresh,
  listPendingAnnualReports,
  markAnnualReportViewed,
  startAnnualReportGeneration,
} from "../annual-report-store";
import { jsonRepositoryError, requireFunctionalUser } from "../http";
import { parseInstanceIdentity } from "../runtime-config";

type YearContext<Path extends string> = Context<{ Bindings: Env }, Path>;

/** Seconds a client waits before asking about a report's generation again, Mastodon's. */
const GENERATION_RETRY_SECONDS = 2;

/**
 * `Mastodon-Async-Refresh` for a report's generation. Its id is Mastodon's
 * Redis key, which `/api/v1_alpha/async_refreshes/:id` reads back.
 */
const refreshHeader = (accountId: string, year: number): string =>
  `id="wrapstodon:${accountId}:${year}", retry=${GENERATION_RETRY_SECONDS}`;

/**
 * The year a request names, as Ruby's `params[:id].to_i` reads it: its
 * leading integer, or 0.
 */
const yearParam = (raw: string): number => {
  const digits = /^\s*([+-]?\d+)/.exec(raw)?.[1];
  return digits === undefined ? 0 : Number.parseInt(digits, 10);
};

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

/** The owner's reports, as `REST::AnnualReportsSerializer` renders them for the owner. */
const reportsResponse = async (
  c: Context<{ Bindings: Env }>,
  owner: LocalAccount,
  reports: ReadonlyArray<AnnualReport>,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const document = await annualReportsDocument(c.env, identity.value, owner, reports, owner.id);
  if (document.isErr()) {
    return jsonRepositoryError(c, document.error.message);
  }
  return c.json(document.value);
};

/** Mastodon 4.7 `Api::V1::AnnualReportsController#index`: the reports not viewed yet. */
export const getV1AnnualReports = async (c: YearContext<"/api/v1/annual_reports">) => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const reports = await listPendingAnnualReports(c.env.DB, user.value.id);
  if (reports.isErr()) {
    return jsonRepositoryError(c, reports.error.message);
  }
  return reportsResponse(c, user.value, reports.value);
};

/** `#show`: the report of the year, viewed or not. */
export const getV1AnnualReportsById = async (c: YearContext<"/api/v1/annual_reports/:id">) => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const report = await findAnnualReport(c.env.DB, user.value.id, yearParam(c.req.param("id")));
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (!report.value) {
    return notFound(c);
  }
  return reportsResponse(c, user.value, [report.value]);
};

/** `#state`, with `Mastodon-Async-Refresh` while the report is generated. */
export const getV1AnnualReportsByIdState = async (
  c: YearContext<"/api/v1/annual_reports/:id/state">,
) => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const year = yearParam(c.req.param("id"));
  const state = await annualReportState(c.env.DB, user.value.id, year, new Date());
  if (state.isErr()) {
    return jsonRepositoryError(c, state.error.message);
  }
  if (state.value === "generating") {
    c.header("Mastodon-Async-Refresh", refreshHeader(user.value.id, year));
  }
  const document: ApiAnnualReportStateJSON = { state: state.value };
  return c.json(document);
};

/**
 * `#generate`: queue the report of the campaign's year, answering 202 with
 * the refresh to poll. Any other year, or a report already generated, is
 * answered `{}`.
 */
export const postV1AnnualReportsByIdGenerate = async (
  c: YearContext<"/api/v1/annual_reports/:id/generate">,
) => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const accountId = user.value.id;
  const year = yearParam(c.req.param("id"));
  const now = new Date();
  if (year !== annualReportCampaign(now)) {
    return c.json({});
  }
  const report = await findAnnualReport(c.env.DB, accountId, year);
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  if (report.value) {
    return c.json({});
  }
  const refresh = await findAnnualReportRefresh(c.env.DB, accountId, year, now);
  if (refresh.isErr()) {
    return jsonRepositoryError(c, refresh.error.message);
  }
  if (refresh.value?.kind !== "Running") {
    const started = await startAnnualReportGeneration(c.env.DB, accountId, year, now);
    if (started.isErr()) {
      return jsonRepositoryError(c, started.error.message);
    }
    if (!(await queueAnnualReportGeneration(c.env, accountId, year))) {
      return c.json({ error: "The report could not be queued", kind: "QueueUnavailable" }, 503);
    }
  }
  c.header("Mastodon-Async-Refresh", refreshHeader(accountId, year));
  return c.body(null, 202);
};

/** `#read`: the owner has seen the report, so `#index` no longer lists it. */
export const postV1AnnualReportsByIdRead = async (
  c: YearContext<"/api/v1/annual_reports/:id/read">,
) => {
  const user = await requireFunctionalUser(c);
  if (user.isErr()) {
    return user.error;
  }
  const marked = await markAnnualReportViewed(
    c.env.DB,
    user.value.id,
    yearParam(c.req.param("id")),
    new Date(),
  );
  if (marked.isErr()) {
    return jsonRepositoryError(c, marked.error.message);
  }
  return marked.value ? c.json({}) : notFound(c);
};
