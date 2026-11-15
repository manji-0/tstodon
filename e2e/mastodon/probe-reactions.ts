/** Sweep area INT-12: favourites and boosts by strangers, of followers-only posts, their lists, and their notifications when undone. */
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Accounts,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  notified,
  Notifications,
  onHome,
  post,
  resolveAccount,
  resolveStatus,
  Status,
  Statuses,
  StepFailure,
} from "./sweep.js";

const act = (user: E2eUser, statusId: string, action: string): Promise<Status> =>
  call(user, `/api/v1/statuses/${statusId}/${action}`, Status, { method: "POST", body: {} });

const hasNotification = async (
  user: E2eUser,
  type: string,
  from: E2eUser,
  statusUri: string,
): Promise<boolean> => {
  const list = await call(user, `/api/v1/notifications?types[]=${type}&limit=40`, Notifications);
  return list.some((item) => item.account.uri === from.uri && item.status?.uri === statusUri);
};

/** `viewer`'s server lists a boost of `uri` among `booster`'s statuses. */
const profileListsBoost = async (viewer: E2eUser, booster: E2eUser, uri: string): Promise<void> => {
  const { id } = await resolveAccount(viewer, booster);
  await eventually(
    `${booster.acct}'s profile on ${viewer.username}'s server lists the boost`,
    async () => {
      const statuses = await call(viewer, `/api/v1/accounts/${id}/statuses?limit=20`, Statuses);
      return statuses.some((status) => status.reblog?.uri === uri) ? true : undefined;
    },
  );
};

export const reactionScenarios = async ({ stamp, mona, carol }: Cast): Promise<void> => {
  const alice = await signUp(A, "rhea");
  const bob = await signUp(A, "remy");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays(
    "a stranger's favourite counts, notifies and is listed",
    alice,
    mona,
    async (from, to) => {
      const stranger = from === alice ? bob : carol;
      const target = await post(to, { status: `like me, stranger ${stamp}` });
      const copy = await resolveStatus(stranger, target.uri);
      const liked = await act(stranger, copy.id, "favourite");
      if (liked.favourited !== true || liked.favourites_count < 1) {
        throw new StepFailure(
          `the stranger's server answers favourited ${String(liked.favourited)}, count ${liked.favourites_count}`,
        );
      }
      await notified(to, "favourite", stranger, target.uri);
      await eventually("favourited_by lists the stranger", async () => {
        const by = await call(to, `/api/v1/statuses/${target.id}/favourited_by`, Accounts);
        return by.some((account) => account.uri === stranger.uri) ? true : undefined;
      });
    },
  );

  await bothWays(
    "a stranger's boost counts, notifies and is listed",
    alice,
    mona,
    async (from, to) => {
      const stranger = from === alice ? bob : carol;
      const target = await post(to, { status: `boost me, stranger ${stamp}` });
      const copy = await resolveStatus(stranger, target.uri);
      const boosted = await act(stranger, copy.id, "reblog");
      if (boosted.reblog?.uri !== target.uri) {
        throw new StepFailure(`the boost wraps ${String(boosted.reblog?.uri)}`);
      }
      await notified(to, "reblog", stranger, target.uri);
      await eventually("reblogged_by lists the stranger", async () => {
        const by = await call(to, `/api/v1/statuses/${target.id}/reblogged_by`, Accounts);
        return by.some((account) => account.uri === stranger.uri) ? true : undefined;
      });
      await eventually("the author's server counts one boost", async () =>
        (await call(to, `/api/v1/statuses/${target.id}`, Status)).reblogs_count === 1
          ? true
          : undefined,
      );
    },
  );

  await bothWays(
    "a follower's favourite of a followers-only post counts and notifies",
    alice,
    mona,
    async (from, to) => {
      const target = await post(to, { status: `private, like me ${stamp}`, visibility: "private" });
      const copy = await onHome(from, target.uri);
      await act(from, copy.id, "favourite");
      await notified(to, "favourite", from, target.uri);
      await eventually("favourites_count is 1", async () =>
        (await call(to, `/api/v1/statuses/${target.id}`, Status)).favourites_count === 1
          ? true
          : undefined,
      );
    },
  );

  await bothWays(
    "an author's boost of their own followers-only post reaches a follower",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, {
        status: `private, self boost ${stamp}`,
        visibility: "private",
      });
      await onHome(to, sent.uri);
      await act(from, sent.id, "reblog");
      // Mastodon leaves a boost out of a home feed that already holds the
      // boosted post, so the booster's profile is where the boost shows.
      await profileListsBoost(to, from, sent.uri);
    },
  );

  await bothWays(
    "an undone favourite withdraws its notification",
    alice,
    mona,
    async (from, to) => {
      const target = await post(to, { status: `like, then unlike ${stamp}` });
      const copy = await onHome(from, target.uri);
      await act(from, copy.id, "favourite");
      await notified(to, "favourite", from, target.uri);
      await act(from, copy.id, "unfavourite");
      await eventually("the favourite notification is gone", async () =>
        (await hasNotification(to, "favourite", from, target.uri)) ? undefined : true,
      );
    },
  );

  await bothWays("an undone boost withdraws its notification", alice, mona, async (from, to) => {
    const target = await post(to, { status: `boost, then unboost ${stamp}` });
    const copy = await onHome(from, target.uri);
    await act(from, copy.id, "reblog");
    await notified(to, "reblog", from, target.uri);
    await act(from, copy.id, "unreblog");
    await eventually("the boost notification is gone", async () =>
      (await hasNotification(to, "reblog", from, target.uri)) ? undefined : true,
    );
    await eventually("reblogged_by is empty", async () => {
      const by = await call(to, `/api/v1/statuses/${target.id}/reblogged_by`, Accounts);
      return by.length === 0 ? true : undefined;
    });
  });

  await bothWays(
    "a boost shows on the booster's profile on the author's server",
    alice,
    mona,
    async (from, to) => {
      const target = await post(to, { status: `on your profile ${stamp}` });
      const copy = await onHome(from, target.uri);
      await act(from, copy.id, "reblog");
      await notified(to, "reblog", from, target.uri);
      await profileListsBoost(to, from, target.uri);
    },
  );
};
