import { type InstanceIdentity, type RemoteBoostValue, Visibility } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { presentedAccounts } from "./account-documents";
import { boostedStatusAuthors, StatusAuthors } from "./account-presentation";
import type { RepositoryError } from "./d1";
import { mastodonStatuses } from "./local-status-documents";
import { RemoteAccountId } from "./remote-account-id";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { mastodonRemoteStatuses } from "./remote-status-documents";
import { findRemoteStatusesByIds } from "./remote-status-store";
import { findStatusesByIds } from "./status-store";
import { documentsById } from "./documents-by-id";

/**
 * Remote boosts as Mastodon statuses: the booster as `account`, the boosted
 * local or remote status as `reblog`, and the boost's own id, time, visibility,
 * and `Announce` URI. A boost whose booster or status is gone, or whose
 * booster's presentation `authors` refuses, is left out; the boosted status
 * of a suspended author stays, its author stripped.
 */
export const remoteBoostDocuments = async (
  env: Env,
  identity: InstanceIdentity,
  boosts: ReadonlyArray<RemoteBoostValue>,
  viewerId: string | undefined,
  authors: StatusAuthors = StatusAuthors.available,
): Promise<Result<Record<string, unknown>[], RepositoryError>> => {
  if (boosts.length === 0) {
    return ok([]);
  }
  const targetIds = (kind: RemoteBoostValue["target"]["kind"]) =>
    boosts.flatMap((boost) => (boost.target.kind === kind ? [boost.target.statusId] : []));
  const [locals, remotes, actors] = await Promise.all([
    findStatusesByIds(env.DB, targetIds("LocalStatus")),
    findRemoteStatusesByIds(env.DB, targetIds("RemoteStatus")),
    findRemoteActorsByUris(
      env.DB,
      boosts.map((boost) => boost.actorUri),
    ),
  ]);
  if (locals.isErr()) {
    return err(locals.error);
  }
  if (remotes.isErr()) {
    return err(remotes.error);
  }
  if (actors.isErr()) {
    return err(actors.error);
  }
  const boosted = boostedStatusAuthors(authors);
  const [localDocuments, remoteDocuments, boosters] = await Promise.all([
    mastodonStatuses(env, identity, [...locals.value.values()], viewerId, boosted),
    mastodonRemoteStatuses(env, identity, [...remotes.value.values()], viewerId, boosted),
    presentedAccounts(env, identity, [], [...actors.value.values()]),
  ]);
  if (boosters.isErr()) {
    return err(boosters.error);
  }
  if (localDocuments.isErr()) {
    return err(localDocuments.error);
  }
  if (remoteDocuments.isErr()) {
    return err(remoteDocuments.error);
  }
  const documents = documentsById([...localDocuments.value, ...remoteDocuments.value]);
  return ok(
    boosts.flatMap((boost) => {
      const booster = boosters.value.get(RemoteAccountId.encode(boost.actorUri));
      const reblog = documents.get(boost.target.statusId);
      if (!booster || !authors(booster.presentation) || !reblog) {
        return [];
      }
      return [
        {
          ...reblog,
          id: boost.id,
          uri: boost.activityId,
          created_at: boost.publishedAt,
          visibility: Visibility.toMastodon(boost.visibility),
          account: booster.document,
          reblog,
        },
      ];
    }),
  );
};
