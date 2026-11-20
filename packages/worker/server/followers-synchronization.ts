import { FollowersSynchronization, InstanceIdentity, type Visibility } from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { accountCounts } from "./account-count-store";
import type { RepositoryError } from "./d1";
import { remoteFollowerUrisUnder } from "./followers-synchronization-store";
import { optionalEnvString } from "./runtime-config";

/** Mastodon's `DISABLE_FOLLOWERS_SYNCHRONIZATION`: neither send the header nor act on one. */
export const followersSynchronizationDisabled = (env: Env): boolean =>
  optionalEnvString(env, "DISABLE_FOLLOWERS_SYNCHRONIZATION") === "true";

/**
 * Whether a status's `Create`, `Update` or `Announce` goes out with a
 * `Collection-Synchronization` header, as `DistributionWorker#options` asks
 * when it is queued: a followers-only status of an account with fewer than
 * 25,000 followers. An unreadable count sends none; the header is optional.
 */
export const synchronizesFollowers = async (
  db: D1Database,
  accountId: string,
  visibility: Visibility,
): Promise<boolean> => {
  if (visibility.kind !== "FollowersOnly") {
    return false;
  }
  const counts = await accountCounts(db, accountId);
  return counts.isOk() && FollowersSynchronization.synchronizes(visibility, counts.value.followers);
};

/**
 * The `Collection-Synchronization` header of a POST to `inboxUrl` by the
 * local account `username` (`DeliveryWorker#synchronization_header`): its
 * followers collection, the digest of its followers under the inbox's
 * scheme and authority (`remote_followers_hash`, read at each attempt), and
 * where the receiver reads them. An inbox URL with no such prefix gets an
 * empty digest, as Mastodon interpolates `nil`.
 */
export const collectionSynchronizationHeader = async (
  db: D1Database,
  identity: InstanceIdentity,
  account: Readonly<{ id: string; username: string }>,
  inboxUrl: string,
): Promise<Result<string, RepositoryError>> => {
  const actorUrl = InstanceIdentity.actorUrl(identity, account.username);
  const header = (digest: string): string =>
    FollowersSynchronization.header({
      collectionId: `${actorUrl}/followers`,
      digest,
      url: `${actorUrl}/followers_synchronization`,
    });
  const prefix = FollowersSynchronization.uriPrefix(inboxUrl);
  if (prefix === undefined) {
    return ok(header(""));
  }
  const followers = await remoteFollowerUrisUnder(db, account.id, prefix);
  if (followers.isErr()) {
    return err(followers.error);
  }
  return ok(header(await FollowersSynchronization.digest(followers.value)));
};
