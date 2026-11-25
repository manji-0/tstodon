import type { ApiAnnualReportJSON, ApiAnnualReportsJSON } from "@tstodon/api";
import type { InstanceIdentity, LocalAccount } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { accountDocumentsByIds, documentsInOrder } from "./account-documents";
import type { AnnualReport } from "./annual-report-store";
import type { RepositoryError } from "./d1";
import { statusDocumentsByIds } from "./status-documents";

/** The report's public page, Mastodon's `public_wrapstodon_url`. */
export const annualReportSharePath = (username: string, year: number, shareKey: string): string =>
  `/@${username}/wrapstodon/${year}/${shareKey}`;

/** `REST::AnnualReportSerializer`. */
const reportDocument = (
  identity: InstanceIdentity,
  owner: LocalAccount,
  report: AnnualReport,
): ApiAnnualReportJSON => ({
  year: report.year,
  data: report.data,
  schema_version: 2,
  share_url:
    report.shareKey === undefined
      ? null
      : `${identity.publicOrigin.replace(/\/$/, "")}${annualReportSharePath(owner.username, report.year, report.shareKey)}`,
  account_id: report.accountId,
});

/**
 * `REST::AnnualReportsSerializer` over `AnnualReportsPresenter`: `owner`'s
 * reports, the owner (schema 2 names no other account) and the top statuses
 * still held, rendered for `viewerId`.
 */
export const annualReportsDocument = async (
  env: Env,
  identity: InstanceIdentity,
  owner: LocalAccount,
  reports: ReadonlyArray<AnnualReport>,
  viewerId: string | undefined,
): Promise<Result<ApiAnnualReportsJSON, RepositoryError>> => {
  const accountIds = reports.length === 0 ? [] : [owner.id];
  const statusIds = [
    ...new Set(
      reports.flatMap((report) => {
        const { by_reblogs, by_favourites, by_replies } = report.data.top_statuses;
        return [by_reblogs, by_favourites, by_replies].flatMap((id) => (id === null ? [] : [id]));
      }),
    ),
  ];
  const [accounts, statuses] = await Promise.all([
    accountDocumentsByIds(env, identity, viewerId, accountIds),
    statusDocumentsByIds(env, identity, statusIds, viewerId),
  ]);
  if (accounts.isErr()) {
    return err(accounts.error);
  }
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  return ok({
    annual_reports: reports.map((report) => reportDocument(identity, owner, report)),
    accounts: documentsInOrder(accountIds, accounts.value),
    statuses: documentsInOrder(statusIds, statuses.value),
  });
};
