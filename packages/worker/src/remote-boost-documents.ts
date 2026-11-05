import { type InstanceIdentity, type RemoteBoostValue, Visibility } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { mastodonRemoteAccount } from "./account-documents";
import type { RepositoryError } from "./d1";
import { mastodonStatuses } from "./local-status-documents";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { mastodonRemoteStatuses } from "./remote-status-documents";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { findStatusesByIds } from "./status-store";
import { documentsById } from "./documents-by-id";

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
  const [locals, remotes] = await Promise.all([
    findStatusesByIds(env.DB, targetIds("LocalStatus")),
    findRemoteStatusesByIds(env.DB, targetIds("RemoteStatus")),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  const [localDocuments, remoteDocuments, actors] = await Promise.all([
    mastodonStatuses(env, identity, [...locals.value.values()], viewerId),
    mastodonRemoteStatuses(env, identity, [...remotes.value.values()], viewerId),
    findRemoteActorsByUris(
      env.DB,
      boosts.map((boost) => boost.actorUri),
    ),
  ]);
  if (actors.isErr()) {
    return err(actors.error);
  }
  const documents = documentsById([...localDocuments, ...remoteDocuments]);
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
