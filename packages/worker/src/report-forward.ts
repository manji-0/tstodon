import { authorityHost } from "./domain-block-store";
import { InstanceIdentity, RemoteActor } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { enqueueInstanceActorActivity, type EnqueueLocalActivityError } from "./delivery";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemoteStatusReplyTargets } from "./remote-reply-store";
import { findRemoteStatusRefsByObjectUris } from "./remote-status-store";
import { listStatusReplyUris } from "./status-store";

/** What a forwarded `Flag` names: the reported account and posts, by ActivityPub id. */
export type ForwardedReport = Readonly<{
  id: string;
  targetUri: string;
  comment: string;
  statusUris: ReadonlyArray<string>;
}>;

/**
 * Send a report to another server as Mastodon's `ReportService` does: a `Flag`
 * from the instance actor, so that server learns what was reported but not
 * who reported it, naming the account and the reported posts.
 */
const sendFlag = (
  env: Env,
  identity: InstanceIdentity,
  report: ForwardedReport,
  inboxUrl: string,
): Promise<Result<void, EnqueueLocalActivityError>> => {
  const actor = InstanceIdentity.instanceActorUrl(identity);
  return enqueueInstanceActorActivity(
    env,
    "Flag",
    {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor}/flags/${report.id}`,
      type: "Flag",
      actor,
      content: report.comment,
      object: [report.targetUri, ...report.statusUris],
    },
    inboxUrl,
  );
};

/** Forward a report on a remote account to that account's server. */
export const forwardReport = (
  env: Env,
  identity: InstanceIdentity,
  report: ForwardedReport,
  target: RemoteActor,
): Promise<Result<void, EnqueueLocalActivityError>> =>
  sendFlag(env, identity, report, target.inboxUri);

/**
 * Where a report could also go: the servers of the accounts its posts reply
 * to, other than `ownDomain` (the reported account's server, which `forward`
 * reaches). Each is a shared inbox of the replied-to account's cached actor,
 * keyed by lowercase domain; a parent post this server has not cached names
 * no server.
 */
export const repliedToInboxes = async (
  db: D1Database,
  statusIds: ReadonlyArray<string>,
  ownDomain: string | undefined,
): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => {
  const [localReplies, remoteReplies] = await Promise.all([
    listStatusReplyUris(db, statusIds),
    findRemoteStatusReplyTargets(db, statusIds),
  ]);
  if (localReplies.isErr()) {
    return err(localReplies.error);
  }
  if (remoteReplies.isErr()) {
    return err(remoteReplies.error);
  }
  const parentUris = [
    ...localReplies.value.values(),
    ...[...remoteReplies.value.values()].flatMap((target) =>
      target.inReplyToUri === undefined ? [] : [target.inReplyToUri],
    ),
  ];
  const parents = await findRemoteStatusRefsByObjectUris(db, parentUris);
  if (parents.isErr()) {
    return err(parents.error);
  }
  const actors = await findRemoteActorsByUris(
    db,
    [...parents.value.values()].map((parent) => parent.actorUri),
  );
  if (actors.isErr()) {
    return err(actors.error);
  }
  const inboxes = new Map<string, string>();
  for (const actor of actors.value.values()) {
    const domain = authorityHost(actor.domain);
    if (domain !== ownDomain?.toLowerCase() && !inboxes.has(domain)) {
      inboxes.set(domain, RemoteActor.deliveryInbox(actor));
    }
  }
  return ok(inboxes);
};

/**
 * Forward a report to each requested domain it reaches: `requested` is the
 * client's `forward_to_domains[]`, and a domain no replied-to account lives on
 * is ignored. Suspended domains and ones outside the allow list are dropped
 * by the delivery queue. Resolves to the domains the `Flag` was queued for.
 */
export const forwardReportToDomains = async (
  env: Env,
  identity: InstanceIdentity,
  report: ForwardedReport,
  requested: ReadonlyArray<string>,
  reachable: ReadonlyMap<string, string>,
): Promise<
  ReadonlyArray<Readonly<{ domain: string; result: Result<void, EnqueueLocalActivityError> }>>
> => {
  const targets = [...new Set(requested.map((domain) => domain.trim().toLowerCase()))].flatMap(
    (domain) => {
      const inbox = reachable.get(domain);
      return inbox === undefined ? [] : [{ domain, inbox }];
    },
  );
  return Promise.all(
    targets.map(async ({ domain, inbox }) => ({
      domain,
      result: await sendFlag(env, identity, report, inbox),
    })),
  );
};
