import type {
  InstanceIdentity,
  LocalStatusValue,
  RemoteActor,
  RemoteStatus,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { accountDocumentsByIds } from "./account-documents";
import type { RepositoryError } from "./d1";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { findReportById, ReportParty } from "./report-store";
import { findStatusesByIds } from "./status-store";

/** The posts attached to a report: local ones, and remote ones with their author. */
export type ReportedStatuses = Readonly<{
  local: ReadonlyArray<LocalStatusValue>;
  remote: ReadonlyArray<Readonly<{ status: RemoteStatus; actor: RemoteActor }>>;
}>;

export const reportedStatuses = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
): Promise<Result<ReportedStatuses, RepositoryError>> => {
  const [local, remote] = await Promise.all([
    findStatusesByIds(db, statusIds),
    findRemoteStatusesByIds(db, statusIds),
  ]);
  if (local.isErr()) {
    return err(local.error);
  }
  if (remote.isErr()) {
    return err(remote.error);
  }
  const actors = await findRemoteActorsByUris(
    db,
    [...remote.value.values()].map((status) => status.actorUri),
  );
  if (actors.isErr()) {
    return err(actors.error);
  }
  return ok({
    local: [...local.value.values()],
    remote: [...remote.value.values()].flatMap((status) => {
      const actor = actors.value.get(status.actorUri);
      return actor ? [{ status, actor }] : [];
    }),
  });
};

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
    rows.map((row) => ReportParty.accountId(row.target)),
  );
  const documents = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const target = targets.get(ReportParty.accountId(row.target));
    if (!target) {
      continue;
    }
    documents.set(row.id, {
      id: row.id,
      action_taken: row.resolution.kind === "Resolved",
      action_taken_at: row.resolution.kind === "Resolved" ? row.resolution.at : null,
      category: row.category,
      comment: row.comment,
      forwarded: row.forwarding.kind === "Forwarded",
      created_at: row.createdAt,
      status_ids: row.statusIds,
      rule_ids: row.ruleIds,
      target_account: target,
    });
  }
  return documents;
};
