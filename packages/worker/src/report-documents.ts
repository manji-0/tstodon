import type { InstanceIdentity } from "@tstodon/domain";
import { accountDocumentsByIds } from "./account-documents";
import { findReportById } from "./report-store";

/**
 * Mastodon's `Report` entity, as an `admin.report` notification carries it.
 * Reports that no longer exist, or whose target no longer resolves, are left
 * out.
 */
export const reportDocumentsByIds = async (
  env: Env,
  identity: InstanceIdentity,
  ids: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Record<string, unknown>>> => {
  const reports = await Promise.all([...new Set(ids)].map((id) => findReportById(env.DB, id)));
  const rows = reports.flatMap((found) => (found.isOk() && found.value ? [found.value] : []));
  const targets = await accountDocumentsByIds(
    env,
    identity,
    rows.map((row) => row.targetAccountId),
  );
  const documents = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const target = targets.get(row.targetAccountId);
    if (!target) {
      continue;
    }
    documents.set(row.id, {
      id: row.id,
      action_taken: row.actionTakenAt !== null,
      action_taken_at: row.actionTakenAt,
      category: row.category,
      comment: row.comment,
      forwarded: false,
      created_at: row.createdAt,
      status_ids: row.statusIds,
      rule_ids: row.ruleIds,
      target_account: target,
    });
  }
  return documents;
};
