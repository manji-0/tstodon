/**
 * Sweep area INT-7, domain blocks: a user's block of the other server's
 * domain, and an admin's silence and suspension of it, by each server.
 *
 * It runs last. An admin's domain suspension purges what the suspending
 * server holds of the other one (Mastodon's `BlockDomainService` runs
 * `DeleteAccountService` on every account of the domain), and lifting it
 * brings back the accounts, not their posts or follows: an area after it
 * would find its follows gone.
 */
import { z } from "zod";
import { A, A_DOMAIN, signUp, sleep, type E2eUser } from "../lib.js";
import { MASTODON, MASTODON_DOMAIN, mastodonUser } from "./lib.js";
import {
  Accounts,
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  fetchWaitingOutRateLimit,
  follow,
  mastodonUsers,
  Notifications,
  onHome,
  post,
  relationship,
  relationshipBecomes,
  resolveAccount,
  Statuses,
  step,
  StepFailure,
  tstodonAdmin,
} from "./sweep.js";

const DomainBlockId = z.looseObject({ id: z.string() });
const AdminAccount = z.looseObject({ silenced: z.boolean(), suspended: z.boolean() });
const FollowRequests = z.array(z.looseObject({ uri: z.string() }));

const domainOf = (user: E2eUser): string => (user.origin === MASTODON ? MASTODON_DOMAIN : A_DOMAIN);

const notifications = (user: E2eUser) =>
  call(user, "/api/v1/notifications?limit=40", Notifications);

const onPublicTimeline = async (viewer: E2eUser, uri: string): Promise<boolean> =>
  (await call(viewer, "/api/v1/timelines/public?limit=40", Statuses)).some(
    (status) => status.uri === uri,
  );

const onHomeTimeline = async (viewer: E2eUser, uri: string): Promise<boolean> =>
  (await call(viewer, "/api/v1/timelines/home?limit=40", Statuses)).some(
    (status) => status.uri === uri,
  );

/**
 * Wait until `viewer` neither follows the account nor is followed by it. On
 * Mastodon the answer is the viewer's following and followers lists, which
 * it reads from the database: its relationship answer is cached, and a read
 * that overlaps the commit ending a follow can cache the follow for a day
 * (see `followsAfterAccept`).
 */
const followsEnded = (viewer: E2eUser, accountId: string) =>
  eventually(`${viewer.username}'s server ends both follows`, async () => {
    if (viewer.origin === MASTODON) {
      const lists = await Promise.all(
        ["following", "followers"].map((list) =>
          call(viewer, `/api/v1/accounts/${viewer.id}/${list}?limit=80`, Accounts),
        ),
      );
      return lists.flat().some((account) => account.id === accountId) ? undefined : true;
    }
    const state = await relationship(viewer, accountId);
    return state.following || state.followed_by ? undefined : true;
  });

/**
 * `blocker` blocks the domain of `peer`, with whom it follows both ways
 * (`POST /api/v1/domain_blocks`). Mastodon's `AfterBlockDomainFromAccountService`
 * unfollows the domain's accounts (`Undo(Follow)`), rejects their follows
 * (`Reject(Follow)`), deletes their notifications and tells the blocker what
 * it lost (`severed_relationships`); the unfollow takes their posts off the
 * home timeline, and the public timeline leaves the domain out
 * (`Status.not_domain_blocked_by_account`). A new follow from the domain is
 * rejected (`ActivityPub::Activity::Follow`), and a new mention does not
 * notify (`NotifyService`). The block goes at the end, and the follows stay
 * gone, as in Mastodon. Unblocking a domain that is not blocked answers 200.
 */
const userDomainBlock = async (blocker: E2eUser, peer: E2eUser, stamp: string): Promise<void> => {
  const peerId = await follow(blocker, peer);
  const blockerId = await follow(peer, blocker);
  const before = await post(peer, { status: `${blocker.acct} before the domain block ${stamp}` });
  await onHome(blocker, before.uri);
  await eventually("the mention notifies the blocker", async () =>
    (await notifications(blocker)).some((item) => item.status?.uri === before.uri)
      ? true
      : undefined,
  );
  await eventually("the post is on the blocker's public timeline", async () =>
    (await onPublicTimeline(blocker, before.uri)) ? true : undefined,
  );
  const domain = domainOf(peer);
  const unblock = () =>
    call(blocker, `/api/v1/domain_blocks?domain=${encodeURIComponent(domain)}`, Anything, {
      method: "DELETE",
    });
  await call(blocker, "/api/v1/domain_blocks", Anything, { method: "POST", body: { domain } });
  try {
    await followsEnded(peer, blockerId);
    const own = await relationship(blocker, peerId);
    if (own.following || own.followed_by || own.domain_blocking !== true) {
      throw new StepFailure(`the blocker's relationship reads ${JSON.stringify(own)}`);
    }
    await eventually("the post leaves the blocker's home and public timelines", async () =>
      (await onHomeTimeline(blocker, before.uri)) || (await onPublicTimeline(blocker, before.uri))
        ? undefined
        : true,
    );
    await eventually(
      "the domain's notifications are gone, and the severance notifies",
      async () => {
        const list = await notifications(blocker);
        return list.some((item) => item.account.uri === peer.uri) ||
          !list.some((item) => item.type === "severed_relationships")
          ? undefined
          : true;
      },
    );
    await call(peer, `/api/v1/accounts/${blockerId}/follow`, Anything, {
      method: "POST",
      body: {},
    });
    await relationshipBecomes(
      peer,
      blockerId,
      "a new follow from the blocked domain is rejected",
      (state) => !state.following && !state.requested,
    );
    const after = await post(peer, { status: `${blocker.acct} after the domain block ${stamp}` });
    await sleep(5000);
    if ((await notifications(blocker)).some((item) => item.status?.uri === after.uri)) {
      throw new StepFailure("a mention from the blocked domain notified the blocker");
    }
    if ((await relationship(blocker, peerId)).followed_by) {
      throw new StepFailure("the rejected follow shows on the blocker's server");
    }
  } finally {
    await unblock();
  }
  // Mastodon's `unblock_domain!` finds no block now and answers 200 all the same.
  await unblock();
};

/**
 * `admin` silences the domain of `follower`, which then follows `followed`,
 * an unlocked account on the admin's server. Mastodon's
 * `ActivityPub::Activity::Follow` holds a silenced account's follow as a
 * request (`@account.silenced?`); its notification is filtered, as any from a
 * silenced account the followed one does not follow. The request is
 * withdrawn and the block lifted at the end.
 */
const silencedFollowWaits = async (
  admin: E2eUser,
  follower: E2eUser,
  followed: E2eUser,
): Promise<void> => {
  const followerOnAdmin = (await resolveAccount(admin, follower)).id;
  const followedId = (await resolveAccount(follower, followed)).id;
  const created = await call(admin, "/api/v1/admin/domain_blocks", DomainBlockId, {
    method: "POST",
    body: { domain: domainOf(follower), severity: "silence" },
  });
  try {
    await eventually(`${admin.origin} shows the follower silenced`, async () =>
      (await call(admin, `/api/v1/admin/accounts/${followerOnAdmin}`, AdminAccount)).silenced
        ? true
        : undefined,
    );
    await call(follower, `/api/v1/accounts/${followedId}/follow`, Anything, {
      method: "POST",
      body: {},
    });
    await eventually("the followed account has the request", async () => {
      const requests = await call(followed, "/api/v1/follow_requests", FollowRequests);
      return requests.some((account) => account.uri === follower.uri) ? true : undefined;
    });
    await sleep(3000);
    const state = await relationship(follower, followedId);
    if (state.following || !state.requested) {
      throw new StepFailure(`the follower's relationship reads ${JSON.stringify(state)}`);
    }
  } finally {
    await call(admin, `/api/v1/admin/domain_blocks/${created.id}`, Anything, { method: "DELETE" });
    await call(follower, `/api/v1/accounts/${followedId}/unfollow`, Anything, {
      method: "POST",
      body: {},
    });
  }
};

const SuspendedFlag = z.looseObject({ suspended: z.boolean().optional() });

/** `GET /api/v1/accounts/lookup` as `viewer`: whether it finds the account. */
const lookupFinds = async (viewer: E2eUser, acct: string): Promise<boolean> => {
  const path = `/api/v1/accounts/lookup?acct=${encodeURIComponent(acct.replace(/^@/, ""))}`;
  const response = await fetchWaitingOutRateLimit(viewer, path);
  await response.arrayBuffer();
  if (response.status !== 200 && response.status !== 404) {
    throw new StepFailure(`GET ${viewer.origin}${path} → ${response.status}`);
  }
  return response.status === 200;
};

/**
 * What `viewer` on the suspending server reads of the peer under the domain
 * suspension: `GET /api/v1/accounts/:id` renders it, `suspended` as
 * `suspended` says (`set_account` finds any account by id), and the lookup
 * refuses it (`ResolveAccountService` stops at `domain_not_allowed?`).
 */
const peerReads = async (
  viewer: E2eUser,
  peer: E2eUser,
  peerId: string,
  suspended: boolean,
): Promise<void> => {
  const account = await call(viewer, `/api/v1/accounts/${peerId}`, SuspendedFlag);
  if ((account.suspended === true) !== suspended) {
    throw new StepFailure(`GET /api/v1/accounts/${peerId} reads ${JSON.stringify(account)}`);
  }
  if (await lookupFinds(viewer, peer.acct)) {
    throw new StepFailure(`the lookup of ${peer.acct} found it on a suspended domain`);
  }
};

/**
 * `admin` suspends the domain of `peer`, which follows `local` on the
 * admin's server both ways. Mastodon's `DeleteAccountService` on each of the
 * domain's accounts sends a `Reject(Follow)` for its follows and an
 * `Undo(Follow)` for the follows of it, so the peer's server ends both, and
 * `BlockDomainService` tells `local` what it lost (`severed_relationships`).
 * The peer renders `suspended` by id and the lookup refuses it; the admin's
 * per-account unsuspension (`unsuspend!`) renders it again, and the lookup
 * still refuses it. Lifting the block lifts the suspension
 * (`UnblockDomainService`) and restores no follow.
 */
const domainSuspension = async (admin: E2eUser, local: E2eUser, peer: E2eUser): Promise<void> => {
  await follow(local, peer);
  const localOnPeer = await follow(peer, local);
  const peerOnAdmin = (await resolveAccount(admin, peer)).id;
  const created = await call(admin, "/api/v1/admin/domain_blocks", DomainBlockId, {
    method: "POST",
    body: { domain: domainOf(peer), severity: "suspend" },
  });
  try {
    await eventually(`${admin.origin} shows the peer suspended`, async () =>
      (await call(admin, `/api/v1/admin/accounts/${peerOnAdmin}`, AdminAccount)).suspended
        ? true
        : undefined,
    );
    await followsEnded(peer, localOnPeer);
    await eventually("the local account is told of the severance", async () =>
      (await notifications(local)).some((item) => item.type === "severed_relationships")
        ? true
        : undefined,
    );
    await peerReads(local, peer, peerOnAdmin, true);
    const lifted = await call(
      admin,
      `/api/v1/admin/accounts/${peerOnAdmin}/unsuspend`,
      AdminAccount,
      { method: "POST", body: {} },
    );
    if (lifted.suspended) {
      throw new StepFailure(`${admin.origin}'s unsuspension left the peer suspended`);
    }
    await peerReads(local, peer, peerOnAdmin, false);
  } finally {
    await call(admin, `/api/v1/admin/domain_blocks/${created.id}`, Anything, { method: "DELETE" });
  }
  await eventually(`${admin.origin} lifts the peer's suspension with the block`, async () =>
    (await call(admin, `/api/v1/admin/accounts/${peerOnAdmin}`, AdminAccount)).suspended
      ? undefined
      : true,
  );
};

export const domainBlockScenarios = async ({ stamp }: Cast): Promise<void> => {
  const blocker = await signUp(A, "dblk");
  const [peer] = await mastodonUsers([`dblk_${stamp}`]);
  if (!peer) {
    throw new StepFailure("no Mastodon user");
  }
  await bothWays(
    "a user's domain block severs the follows, hides the domain and refuses a new follow",
    blocker,
    peer,
    (from, to) => userDomainBlock(from, to, stamp),
  );

  const tstodonModerator = await tstodonAdmin(await signUp(A, "dmod"));
  const mastodonModerator = await mastodonUser("moderator");

  await step("a follow from a silenced domain waits for approval: on tstodon", async () => {
    const [follower] = await mastodonUsers([`dsf_${stamp}`]);
    if (!follower) {
      throw new StepFailure("no Mastodon user");
    }
    await silencedFollowWaits(tstodonModerator, follower, await signUp(A, "dsfd"));
  });
  await step("a follow from a silenced domain waits for approval: on Mastodon", async () => {
    const [followed] = await mastodonUsers([`dsfd_${stamp}`]);
    if (!followed) {
      throw new StepFailure("no Mastodon user");
    }
    await silencedFollowWaits(mastodonModerator, await signUp(A, "dsf"), followed);
  });

  await step("a domain suspension ends the follows with the domain: on Mastodon", async () => {
    const [local] = await mastodonUsers([`dsus_${stamp}`]);
    if (!local) {
      throw new StepFailure("no Mastodon user");
    }
    await domainSuspension(mastodonModerator, local, await signUp(A, "dsus"));
  });
  await step("a domain suspension ends the follows with the domain: on tstodon", async () => {
    const [peerToSuspend] = await mastodonUsers([`dsut_${stamp}`]);
    if (!peerToSuspend) {
      throw new StepFailure("no Mastodon user");
    }
    await domainSuspension(tstodonModerator, await signUp(A, "dsut"), peerToSuspend);
  });
};
