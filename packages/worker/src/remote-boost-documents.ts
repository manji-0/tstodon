import { type InstanceIdentity, type RemoteBoostValue, Visibility } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { mastodonRemoteAccount } from "./account-documents";
import type { RepositoryError } from "./d1";
import { cardDocument, parseCardJson } from "./link-card";
import { mastodonStatuses } from "./local-status-documents";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { findRemotePollVotes } from "./remote-poll-vote-store";
import { mastodonRemoteStatus } from "./remote-status-document";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { listRemoteStatusCards } from "./status-card-store";
import { attachRemoteReplyRefs } from "./status-documents";
import { findStatusesByIds } from "./status-store";

/**
 * Remote boosts as Mastodon statuses: the booster as `account`, the boosted
 * local or remote status as `reblog`, and the boost's own id, time, visibility,
 * and `Announce` URI. A boost whose booster or status is gone is left out.
 */
export const remoteBoostDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  boosts: ReadonlyArray<RemoteBoostValue>,
  viewerId: string | undefined,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  if (boosts.length === 0) {
    return ok([]);
  }
  const targetIds = (kind: RemoteBoostValue["target"]["kind"]) =>
    boosts.flatMap((boost) => (boost.target.kind === kind ? [boost.target.statusId] : []));
  const [locals, remotes, cards] = await Promise.all([
    findStatusesByIds(env.DB, targetIds("LocalStatus")),
    findRemoteStatusesByIds(env.DB, targetIds("RemoteStatus")),
    listRemoteStatusCards(env.DB, targetIds("RemoteStatus")),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  const remoteStatuses = [...remotes.value.values()];
  const [localDocuments, actors, pollVotes] = await Promise.all([
    mastodonStatuses(env, identity, [...locals.value.values()], viewerId),
    findRemoteActorsByUris(env.DB, [
      ...boosts.map((boost) => boost.actorUri),
      ...remoteStatuses.map((status) => status.actorUri),
    ]),
    findRemotePollVotes(env.DB, viewerId, remoteStatuses),
  ]);
  if (actors.isErr()) {
    return err(actors.error);
  }
  const documents = new Map<string, Record<string, unknown>>();
  for (const document of localDocuments) {
    if (typeof document.id === "string") {
      documents.set(document.id, document);
    }
  }
  const remoteDocuments: Record<string, unknown>[] = [];
  for (const status of remoteStatuses) {
    const author = actors.value.get(status.actorUri);
    if (!author) {
      continue;
    }
    const rawCard = cards.isOk() ? cards.value.get(status.id) : undefined;
    const card = rawCard ? parseCardJson(rawCard) : undefined;
    const document = mastodonRemoteStatus(
      identity,
      status,
      author,
      card ? cardDocument(card) : null,
      pollVotes.get(status.id),
    );
    remoteDocuments.push(document);
    documents.set(status.id, document);
  }
  await attachRemoteReplyRefs(env.DB, identity, remoteDocuments);
  return ok(
    boosts.flatMap((boost) => {
      const booster = actors.value.get(boost.actorUri);
      const reblog = documents.get(boost.target.statusId);
      if (!booster || !reblog) {
        return [];
      }
      return [
        {
          ...reblog,
          id: boost.id,
          uri: boost.activityId,
          created_at: boost.publishedAt,
          visibility: Visibility.toMastodon(boost.visibility),
          account: mastodonRemoteAccount(identity, booster),
          reblog,
        },
      ];
    }),
  );
};
