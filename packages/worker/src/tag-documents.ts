import { type InstanceIdentity } from "@tstodon/domain";

export const mastodonTag = (
  identity: InstanceIdentity,
  name: string,
  options: {
    history?: ReadonlyArray<{ day: string; uses: string; accounts: string }>;
    following?: boolean;
    featuring?: boolean;
  } = {},
): Record<string, unknown> => ({
  id: name,
  name,
  url: `https://${identity.domain}/tags/${name}`,
  history: options.history ?? [],
  following: options.following ?? false,
  featuring: options.featuring ?? false,
});

export const mastodonFeaturedTag = (
  identity: InstanceIdentity,
  username: string,
  name: string,
  statusesCount: number,
  lastStatusAt: string | null,
): Record<string, unknown> => ({
  id: name,
  name,
  url: `${identity.publicOrigin.replace(/\/$/, "")}/@${username}/tagged/${name}`,
  statuses_count: statusesCount,
  last_status_at: lastStatusAt,
});
