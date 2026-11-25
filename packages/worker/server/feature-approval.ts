import type { ApiFeaturePolicyJSON } from "@tstodon/api";
import { Collection, type LocalAccount, type RemoteActor } from "@tstodon/domain";
import { z } from "zod";
import { jsonStringArray, parseRows, runD1 } from "./d1";

/**
 * Who a rendered account's `feature_approval.current_user` is for: the
 * viewing account, none for an anonymous request, with the follows between
 * it and the accounts rendered that `feature_policy_for_account` reads.
 * Local accounts are named by id and remote ones by actor URI.
 */
export type FeatureViewer = Readonly<{
  accountId: string | undefined;
  /** The accounts the viewer follows (`followed_by?(viewer)`). */
  follows: ReadonlySet<string>;
  /** The remote accounts that follow the viewer (`following?(viewer)`). */
  followedBy: ReadonlySet<string>;
}>;

export const ANONYMOUS_VIEWER: FeatureViewer = {
  accountId: undefined,
  follows: new Set(),
  followedBy: new Set(),
};

/** A local account to render, with the profile flag its policy reads. */
export type FeatureTarget = Readonly<{ account: LocalAccount; discoverable: boolean }>;

const StandingRow = z.object({ relation: z.string(), target: z.string() });

/**
 * The viewer `viewerId` with its follows of the accounts whose approval
 * depends on them, read in one statement and only when one does: a local
 * account that is discoverable and locked, or a remote one whose policy
 * names followers or following. A storage error reads as no follows.
 */
export const loadFeatureViewer = async (
  db: D1Database,
  viewerId: string | undefined,
  locals: ReadonlyArray<FeatureTarget>,
  actors: ReadonlyArray<RemoteActor>,
): Promise<FeatureViewer> => {
  if (viewerId === undefined) {
    return ANONYMOUS_VIEWER;
  }
  const localIds = locals.flatMap((target) =>
    target.discoverable && target.account.locked && target.account.id !== viewerId
      ? [target.account.id]
      : [],
  );
  const actorUris = actors.flatMap((actor) =>
    Collection.featureApprovalReadsFollows(actor.profile.featurePolicy) ? [actor.actorUri] : [],
  );
  if (localIds.length === 0 && actorUris.length === 0) {
    return { ...ANONYMOUS_VIEWER, accountId: viewerId };
  }
  const read = await runD1(async () => {
    const { results } = await db
      .prepare(
        `SELECT 'follows' AS relation, target_account_id AS target FROM follows
         WHERE follower_account_id = ?1 AND kind = 'Accepted' AND target_account_id IN (SELECT value FROM json_each(?2))
         UNION ALL
         SELECT 'follows', actor_uri FROM outbound_follows
         WHERE account_id = ?1 AND state = 'Accepted' AND actor_uri IN (SELECT value FROM json_each(?3))
         UNION ALL
         SELECT 'followedBy', remote_actor_uri FROM remote_follows
         WHERE target_account_id = ?1 AND follow_kind = 'Accepted'
           AND remote_actor_uri IN (SELECT value FROM json_each(?3))`,
      )
      .bind(viewerId, jsonStringArray(localIds), jsonStringArray(actorUris))
      .all();
    return parseRows(StandingRow, results);
  });
  const rows = read.isOk() ? read.value : [];
  const of = (relation: string) =>
    new Set(rows.flatMap((row) => (row.relation === relation ? [row.target] : [])));
  return { accountId: viewerId, follows: of("follows"), followedBy: of("followedBy") };
};

/** `REST::AccountSerializer#feature_approval` of a local account for `viewer`. */
export const localFeatureApproval = (
  viewer: FeatureViewer,
  target: FeatureTarget,
): ApiFeaturePolicyJSON => {
  const { account, discoverable } = target;
  const keys = Collection.featurePolicyKeys({
    kind: "Local",
    discoverable,
    locked: account.locked,
  });
  return {
    automatic: [...keys.automatic],
    manual: [...keys.manual],
    current_user:
      viewer.accountId === undefined
        ? "denied"
        : Collection.featureApproval({
            kind: "Local",
            ownerId: viewer.accountId,
            targetId: account.id,
            targetDiscoverable: discoverable,
            targetLocked: account.locked,
            ownerFollowsTarget: viewer.follows.has(account.id),
            blockedEitherWay: false,
          }),
  };
};

/** `REST::AccountSerializer#feature_approval` of a remote account for `viewer`. */
export const remoteFeatureApproval = (
  viewer: FeatureViewer,
  actor: RemoteActor,
): ApiFeaturePolicyJSON => {
  const policy = actor.profile.featurePolicy;
  const keys = Collection.featurePolicyKeys({ kind: "Remote", policy });
  return {
    automatic: [...keys.automatic],
    manual: [...keys.manual],
    current_user:
      viewer.accountId === undefined
        ? "denied"
        : Collection.featureApproval({
            kind: "Remote",
            policy,
            ownerFollowsTarget: viewer.follows.has(actor.actorUri),
            targetFollowsOwner: viewer.followedBy.has(actor.actorUri),
            blockedEitherWay: false,
          }),
  };
};
