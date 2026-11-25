import type { Context } from "hono";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { ApiCreateReportParamsSchema } from "@tstodon/api";
import { jsonAuthError, jsonRepositoryError, jsonValidationError, requireUser } from "../http";
import { notifyAdmins } from "../admin-notify";
import { instanceRules, parseInstanceIdentity } from "../runtime-config";
import {
  InstanceIdentity,
  type LocalAccount,
  type RemoteActor,
  ReportForwarding,
} from "@tstodon/domain";
import { forwardReport, forwardReportToDomains, repliedToInboxes } from "../report-forward";
import { ok, type Result } from "neverthrow";
import { findAccountById } from "../account-store";
import type { RepositoryError } from "../d1";
import { findRemoteActorByUri } from "../remote-actor-store";
import { reportDocumentsByIds, reportedStatuses } from "../report-documents";
import { insertReport, ReportCategorySchema, ReportParty } from "../report-store";
import { readParams } from "../request-params";
import { collectionUri } from "../collection-documents";
import { findCollections } from "../collection-store";
import { insertReportCollections } from "../report-collection-store";
import { findRemoteCollections } from "../remote-curated-collection-store";

export const postV1Reports = async (c: Context<{ Bindings: Env }, "/api/v1/reports">) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readParams(c, ApiCreateReportParamsSchema);
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
  const requestedRules = (body.value.rule_ids ?? [])
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
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
  // `ReportService#reported_collection_ids`: the target's own, or 404.
  const reportedCollections = await targetCollections(
    c.env.DB,
    identity.value,
    target.value,
    body.value.collection_ids ?? [],
  );
  if (reportedCollections.isErr()) {
    return jsonRepositoryError(c, reportedCollections.error.message);
  }
  if (reportedCollections.value === undefined) {
    return c.json({ error: "Record not found", kind: "NotFound" }, 404);
  }
  const party = ReportParty.ofAccountId(body.value.account_id);
  const statuses = await targetStatuses(c.env.DB, party, body.value.status_ids ?? []);
  if (statuses.isErr()) {
    return jsonRepositoryError(c, statuses.error.message);
  }
  const statusIds = statuses.value.map((status) => status.id);
  // A local account's report stays here, whatever `forward` says.
  const forwardTo =
    body.value.forward === true && target.value.kind === "Remote" ? target.value.actor : undefined;
  const comment = body.value.comment ?? "";
  const report = await insertReport(c.env.DB, {
    reporter: { kind: "Local", accountId: user.value.id },
    target: party,
    targetAcct:
      target.value.kind === "Remote"
        ? `${target.value.actor.username}@${target.value.actor.domain}`
        : undefined,
    statusIds,
    comment,
    category: category.value,
    ruleIds: requestedRules,
    forwarding:
      forwardTo === undefined ? ReportForwarding.notForwarded : ReportForwarding.forwarded,
  });
  if (report.isErr()) {
    return jsonRepositoryError(c, report.error.message);
  }
  const named = await insertReportCollections(
    c.env.DB,
    report.value.id,
    reportedCollections.value.map((collection) => collection.id),
  );
  if (named.isErr()) {
    return jsonRepositoryError(c, named.error.message);
  }
  const targetUri =
    target.value.kind === "Local"
      ? InstanceIdentity.actorUrl(identity.value, target.value.account.username)
      : target.value.actor.actorUri;
  const forwarding = {
    id: report.value.id,
    targetUri,
    comment,
    statusUris: statuses.value.map(
      (status) => status.objectUri ?? `${targetUri}/statuses/${status.id}`,
    ),
    collectionUris: reportedCollections.value.map((collection) => collection.uri),
  };
  if (forwardTo !== undefined) {
    const forwarded = await forwardReport(c.env, identity.value, forwarding, forwardTo);
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
  const requestedDomains = body.value.forward_to_domains ?? [];
  if (requestedDomains.length > 0) {
    // Only servers a reported reply points at are reachable, and never the
    // target's own server, which `forward` covers.
    const reachable = await repliedToInboxes(
      c.env.DB,
      statusIds,
      target.value.kind === "Remote" ? target.value.actor.domain : undefined,
    );
    if (reachable.isErr()) {
      console.error(
        JSON.stringify({
          kind: "ReportForwardFailed",
          reportId: report.value.id,
          error: reachable.error,
        }),
      );
    } else {
      for (const { domain, result } of await forwardReportToDomains(
        c.env,
        identity.value,
        forwarding,
        requestedDomains,
        reachable.value,
      )) {
        if (result.isErr()) {
          console.error(
            JSON.stringify({
              kind: "ReportForwardFailed",
              reportId: report.value.id,
              domain,
              error: result.error,
            }),
          );
        }
      }
    }
  }
  // A failed notification must not lose the filed report.
  await notifyAdmins(c.env, {
    kind: "admin.report",
    fromAccountId: user.value.id,
    reportId: report.value.id,
  });
  // The report as Mastodon's `REST::ReportSerializer` renders it, its target
  // account in full.
  const rendered = await reportDocumentsByIds(c.env, identity.value, user.value.id, [
    report.value.id,
  ]);
  if (rendered.isErr()) {
    return jsonRepositoryError(c, rendered.error.message);
  }
  const document = rendered.value.get(report.value.id);
  return document ? c.json(document) : c.json({ error: "Record not found", kind: "NotFound" }, 404);
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

/**
 * `@target_account.collections.find(collection_ids)`: the target's own
 * collections with their URIs, or `undefined` when one is not the target's.
 */
const targetCollections = async (
  db: D1Database,
  identity: InstanceIdentity,
  target: ReportTarget,
  requested: ReadonlyArray<string>,
): Promise<
  Result<ReadonlyArray<Readonly<{ id: string; uri: string }>> | undefined, RepositoryError>
> => {
  const ids = [...new Set(requested.map(String))];
  if (ids.length === 0) {
    return ok([]);
  }
  if (target.kind === "Local") {
    const found = await findCollections(db, ids);
    return found.map((collections) => {
      const owned = collections.filter((collection) => collection.accountId === target.account.id);
      return owned.length === ids.length
        ? owned.map((collection) => ({
            id: collection.id,
            uri: collectionUri(identity, collection),
          }))
        : undefined;
    });
  }
  const found = await findRemoteCollections(db, ids);
  return found.map((collections) => {
    const owned = collections.filter((collection) => collection.actorUri === target.actor.actorUri);
    return owned.length === ids.length
      ? owned.map((collection) => ({ id: collection.id, uri: collection.uri }))
      : undefined;
  });
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
warmSchemas([ApiCreateReportParamsSchema]);
