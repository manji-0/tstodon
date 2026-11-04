import { authorityHost } from "./domain-block-store";
import { schemaResult, warmSchemas } from "@tstodon/core";
import { InstanceIdentity, type LocalAccount, type RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { findAccountById, findAccountByUsername } from "./account-store";
import { parseLocalActorUsername, parseLocalStatusId } from "./activitypub";
import { findDomainBlockByDomain } from "./admin-domain-block-store";
import { notifyAdmins } from "./admin-notify";
import type { RepositoryError } from "./d1";
import { RemoteAccountId } from "./remote-account-id";
import { insertFlagReport } from "./report-store";
import { findStatusesByIds } from "./status-store";

/** Mastodon keeps this much of a remote report's comment. */
export const REMOTE_REPORT_COMMENT_LIMIT = 1000;

const ObjectReferenceSchema = z.union([
  z.string().min(1),
  z.object({ id: z.string().min(1) }).passthrough(),
]);

const FlagDocumentSchema = z
  .object({
    id: z.string().min(1),
    object: z.union([ObjectReferenceSchema, z.array(ObjectReferenceSchema)]),
    content: z.string().nullable().optional(),
  })
  .passthrough();

const objectUris = (object: z.infer<typeof FlagDocumentSchema>["object"]): string[] =>
  (Array.isArray(object) ? object : [object]).map((entry) =>
    typeof entry === "string" ? entry : entry.id,
  );

/** The local account a URI names exactly: its actor URI, not one of its posts. */
const localActor = async (
  db: D1Database,
  identity: InstanceIdentity,
  uri: string,
): Promise<Result<LocalAccount | undefined, RepositoryError>> => {
  const username = parseLocalActorUsername(identity, uri);
  if (username === undefined || InstanceIdentity.actorUrl(identity, username) !== uri) {
    return ok(undefined);
  }
  return findAccountByUsername(db, username);
};

/**
 * A `Flag` from another server, as Mastodon's `ActivityPub::Activity::Flag`
 * handles it: a report on the first local account it names (or, when it names
 * only posts, on their author) with the posts it lists that are that
 * account's, filed by the sending actor. A server whose domain block rejects
 * reports is ignored, and a redelivered `Flag` files nothing new.
 */
export const receiveRemoteFlag = async (
  env: Env,
  identity: InstanceIdentity,
  sender: RemoteActor,
  raw: unknown,
): Promise<Result<void, RepositoryError>> => {
  const flag = schemaResult(FlagDocumentSchema)(raw);
  if (flag.isErr()) {
    return ok(undefined);
  }
  const block = await findDomainBlockByDomain(env.DB, authorityHost(sender.domain));
  if (block.isErr()) {
    return err(block.error);
  }
  if (block.value !== undefined && block.value.reject_reports !== 0) {
    return ok(undefined);
  }
  const uris = objectUris(flag.value.object);
  let target: LocalAccount | undefined;
  for (const uri of uris) {
    const found = await localActor(env.DB, identity, uri);
    if (found.isErr()) {
      return err(found.error);
    }
    if (found.value) {
      target = found.value;
      break;
    }
  }
  const statusIds = uris.flatMap((uri) => {
    const id = parseLocalStatusId(identity, uri);
    return id === undefined ? [] : [id];
  });
  const statuses = await findStatusesByIds(env.DB, statusIds);
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  if (target === undefined) {
    const author = [...statuses.value.values()][0]?.accountId;
    const found = author === undefined ? ok(undefined) : await findAccountById(env.DB, author);
    if (found.isErr()) {
      return err(found.error);
    }
    target = found.value;
  }
  if (target === undefined) {
    return ok(undefined);
  }
  const targetId = target.id;
  const report = await insertFlagReport(env.DB, {
    reporter: { kind: "Remote", actorUri: sender.actorUri },
    reporterAcct: `${sender.username}@${sender.domain}`,
    target: { kind: "Local", accountId: targetId },
    statusIds: [...new Set(statusIds)].filter(
      (id) => statuses.value.get(id)?.accountId === targetId,
    ),
    comment: Array.from(flag.value.content ?? "")
      .slice(0, REMOTE_REPORT_COMMENT_LIMIT)
      .join(""),
    category: "other",
    flagUri: flag.value.id,
  });
  if (report.isErr()) {
    return err(report.error);
  }
  if (report.value.kind === "Filed") {
    // A failed notification must not lose the filed report.
    await notifyAdmins(env, {
      kind: "admin.report",
      fromAccountId: RemoteAccountId.encode(sender.actorUri),
      fromActorUri: sender.actorUri,
      reportId: report.value.id,
    });
  }
  return ok(undefined);
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([FlagDocumentSchema]);
