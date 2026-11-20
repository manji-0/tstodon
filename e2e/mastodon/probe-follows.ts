/**
 * Sweep area INT-6: follow requests to a locked account, `Reject`, unlocking
 * with requests pending, removed followers, and a quick unfollow.
 */
import { A, signUp, sleep, type E2eUser } from "../lib.js";
import {
  Account,
  Accounts,
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  followsAfterAccept,
  mastodonRails,
  mastodonUsers,
  onHome,
  post,
  relationship,
  relationshipBecomes,
  resolveAccount,
  Statuses,
  step,
  StepFailure,
} from "./sweep.js";

const setLocked = async (user: E2eUser, locked: boolean): Promise<void> => {
  const form = new FormData();
  form.set("locked", String(locked));
  await call(user, "/api/v1/accounts/update_credentials", Account, { method: "PATCH", form });
};

/** `follower` asks to follow the locked `target`; the answer is the pending request on each side. */
const requestFollow = async (
  follower: E2eUser,
  target: E2eUser,
): Promise<{ targetId: string; requesterId: string }> => {
  const account = await resolveAccount(follower, target);
  await call(follower, `/api/v1/accounts/${account.id}/follow`, Anything, {
    method: "POST",
    body: {},
  });
  await relationshipBecomes(
    follower,
    account.id,
    `${follower.acct}'s follow of ${target.acct} is pending`,
    (state) => state.requested && !state.following,
  );
  const request = await eventually(`${target.acct} has the follow request`, async () => {
    const requests = await call(target, "/api/v1/follow_requests", Accounts);
    return requests.find((candidate) => candidate.uri === follower.uri);
  });
  return { targetId: account.id, requesterId: request.id };
};

const answerRequest = (target: E2eUser, requesterId: string, answer: "authorize" | "reject") =>
  call(target, `/api/v1/follow_requests/${requesterId}/${answer}`, Anything, {
    method: "POST",
    body: {},
  });

const followersCount = async (user: E2eUser): Promise<number> =>
  (await call(user, `/api/v1/accounts/${user.id}`, Account)).followers_count;

const isFollower = async (user: E2eUser, follower: E2eUser): Promise<boolean> => {
  const followers = await call(user, `/api/v1/accounts/${user.id}/followers?limit=80`, Accounts);
  return followers.some((account) => account.uri === follower.uri);
};

/** The relationship holds no follow and no request, and still does after late activities landed. */
const staysUnfollowed = async (viewer: E2eUser, accountId: string, label: string) => {
  await relationshipBecomes(
    viewer,
    accountId,
    label,
    (state) => !state.following && !state.requested,
  );
  await sleep(3000);
  const state = await relationship(viewer, accountId);
  if (state.following || state.requested) {
    throw new StepFailure(`${label}: it came back as ${JSON.stringify(state)}`);
  }
};

/** Follow requests to the locked `target`: one authorized, one rejected and then asked again. */
const lockedAccount = async (
  stamp: string,
  direction: string,
  target: E2eUser,
  accepted: E2eUser,
  rejected: E2eUser,
): Promise<void> => {
  await setLocked(target, true);
  try {
    await step(`a locked account authorizes a follow request: ${direction}`, async () => {
      const { targetId, requesterId } = await requestFollow(accepted, target);
      await answerRequest(target, requesterId, "authorize");
      await followsAfterAccept(accepted, targetId, "the requester follows after the Accept");
      const sent = await post(target, {
        status: `for my followers ${stamp}`,
        visibility: "private",
      });
      await onHome(accepted, sent.uri);
    });

    await step(`a locked account rejects a follow request: ${direction}`, async () => {
      const { targetId, requesterId } = await requestFollow(rejected, target);
      await answerRequest(target, requesterId, "reject");
      await staysUnfollowed(rejected, targetId, "the requester's request is gone after the Reject");
      if (await isFollower(target, rejected)) {
        throw new StepFailure("the rejected requester is among the followers");
      }
    });

    await step(`a follow again after a reject is a new request: ${direction}`, async () => {
      const { targetId, requesterId } = await requestFollow(rejected, target);
      await answerRequest(target, requesterId, "authorize");
      await followsAfterAccept(rejected, targetId, "the requester follows after the Accept");
    });
  } finally {
    await setLocked(target, false);
  }
};

/** Post a tstodon settings form with the user's browser session. */
const postSettings = async (user: E2eUser, path: string, fields: Record<string, string>) => {
  const response = await user.browser(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const page = await response.text();
  if (!response.ok) {
    throw new StepFailure(`POST ${path} → ${response.status} ${page.slice(0, 300)}`);
  }
};

/** Whether `viewer` follows `accountId`, read from its following list (see `followsAfterAccept`). */
const follows = async (viewer: E2eUser, accountId: string): Promise<boolean> => {
  const following = await call(
    viewer,
    `/api/v1/accounts/${viewer.id}/following?limit=80`,
    Accounts,
  );
  return following.some((account) => account.id === accountId);
};

/**
 * FEP-8fcf. A follow only the receiving server still holds is dropped once
 * the followed account posts for its followers: the delivery carries a
 * `Collection-Synchronization` digest, the receiver reads the sender's
 * `followers_synchronization` list, signed, and unfollows. Mastodon's
 * database is changed with `rails runner`, without federating, to make the
 * two servers disagree.
 */
const followersSynchronization = async (stamp: string): Promise<void> => {
  await step("followers synchronization drops a stale follow: tstodon → Mastodon", async () => {
    const author = await signUp(A, "syn");
    const [kept, stale] = await mastodonUsers([`syk_${stamp}`, `sys_${stamp}`]);
    if (!kept || !stale) {
      throw new StepFailure("no Mastodon users");
    }
    const authorId = await follow(kept, author);
    const staleAuthorId = (await resolveAccount(stale, author)).id;
    const made = mastodonRails(
      `Follow.create!(account: Account.find_local!("${stale.username}"), target_account: Account.find_by!(uri: "${author.uri}")); puts "STALE"`,
    );
    if (!made.includes("STALE") || !(await follows(stale, staleAuthorId))) {
      throw new StepFailure(`the stale follow was not made: ${made.slice(-300)}`);
    }
    await post(author, { status: `for my followers ${stamp}`, visibility: "private" });
    await eventually("Mastodon drops the follow tstodon does not list", async () =>
      (await follows(stale, staleAuthorId)) ? undefined : true,
    );
    if (!(await follows(kept, authorId))) {
      throw new StepFailure("Mastodon dropped a follow tstodon lists");
    }
  });

  await step("followers synchronization drops a stale follow: Mastodon → tstodon", async () => {
    const [author] = await mastodonUsers([`sya_${stamp}`]);
    if (!author) {
      throw new StepFailure("no Mastodon user");
    }
    const kept = await signUp(A, "syk");
    const stale = await signUp(A, "sys");
    const authorId = await follow(kept, author);
    const staleAuthorId = await follow(stale, author);
    const dropped = mastodonRails(
      `Follow.find_by!(account: Account.find_by!(uri: "${stale.uri}"), target_account: Account.find_local!("${author.username}")).destroy!; puts "DROPPED"`,
    );
    if (!dropped.includes("DROPPED")) {
      throw new StepFailure(`Mastodon's follow was not dropped: ${dropped.slice(-300)}`);
    }
    await post(author, { status: `for my followers ${stamp}`, visibility: "private" });
    await relationshipBecomes(
      stale,
      staleAuthorId,
      "tstodon drops the follow Mastodon does not list",
      (state) => !state.following && !state.requested,
    );
    if (!(await relationship(kept, authorId)).following) {
      throw new StepFailure("tstodon dropped a follow Mastodon lists");
    }
  });
};

export const followScenarios = async ({ stamp, mona, carol, dana }: Cast): Promise<void> => {
  await followersSynchronization(stamp);

  const alice = await signUp(A, "faye");
  const bob = await signUp(A, "finn");
  const locked = await signUp(A, "lock");

  await lockedAccount(stamp, "Mastodon → tstodon", locked, mona, carol);
  await lockedAccount(stamp, "tstodon → Mastodon", dana, alice, bob);

  await step("unlocking accepts a pending follow request: Mastodon → tstodon", async () => {
    const [requester] = await mastodonUsers([`unl_${stamp}`]);
    if (!requester) {
      throw new StepFailure("no Mastodon user");
    }
    await setLocked(locked, true);
    try {
      const { targetId } = await requestFollow(requester, locked);
      // The privacy page, as Mastodon's own settings form.
      await postSettings(locked, "/settings/privacy", {
        account_unlocked: "1",
        account_discoverable: "1",
        account_indexable: "1",
        account_show_collections: "1",
      });
      await followsAfterAccept(
        requester,
        targetId,
        "the request is accepted once the account is unlocked",
      );
    } finally {
      await setLocked(locked, false);
    }
  });

  await bothWays("remove a follower", alice, mona, async (owner, follower) => {
    const ownerId = await follow(follower, owner);
    const followerId = (await resolveAccount(owner, follower)).id;
    await eventually("the owner lists the follower", async () =>
      (await isFollower(owner, follower)) ? true : undefined,
    );
    await call(owner, `/api/v1/accounts/${followerId}/remove_from_followers`, Anything, {
      method: "POST",
      body: {},
    });
    await staysUnfollowed(follower, ownerId, "the removed follower no longer follows");
    if (await isFollower(owner, follower)) {
      throw new StepFailure("the owner still lists the removed follower");
    }
    const sent = await post(owner, { status: `after the removal ${stamp}`, visibility: "private" });
    await sleep(3000);
    const home = await call(follower, "/api/v1/timelines/home?limit=40", Statuses);
    if (home.some((status) => status.uri === sent.uri)) {
      throw new StepFailure("a followers-only post still reached the removed follower");
    }
  });

  await bothWays("follow, then unfollow at once", bob, carol, async (follower, target) => {
    const account = await resolveAccount(follower, target);
    const before = await followersCount(target);
    await call(follower, `/api/v1/accounts/${account.id}/follow`, Anything, {
      method: "POST",
      body: {},
    });
    await call(follower, `/api/v1/accounts/${account.id}/unfollow`, Anything, {
      method: "POST",
      body: {},
    });
    await staysUnfollowed(follower, account.id, "the follower does not follow");
    await eventually("the target's follower count is back", async () =>
      (await followersCount(target)) === before ? true : undefined,
    );
    if (await isFollower(target, follower)) {
      throw new StepFailure("the target still lists the follower");
    }
    await follow(follower, target);
    await eventually("a later follow counts again", async () =>
      (await followersCount(target)) === before + 1 ? true : undefined,
    );
    // The next run's scenarios need a server that does not get this target's posts.
    await call(follower, `/api/v1/accounts/${account.id}/unfollow`, Anything, {
      method: "POST",
      body: {},
    });
    await eventually("the last unfollow lands", async () =>
      (await followersCount(target)) === before ? true : undefined,
    );
  });
};
