/**
 * Sweep area INT-7: what a block does on the other server, a forwarded report
 * reaching the remote moderators, and what an admin suspension does there.
 */
import { z } from "zod";
import { A, signUp, sleep, type E2eUser } from "../lib.js";
import { mastodonUser } from "./lib.js";
import {
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  tstodonAdmin,
  mastodonUsers,
  Notifications,
  post,
  relationship,
  relationshipBecomes,
  resolveAccount,
  resolveStatus,
  step,
  StepFailure,
} from "./sweep.js";

const AdminReports = z.array(
  z.looseObject({
    id: z.string(),
    comment: z.string(),
    account: z.looseObject({ username: z.string(), domain: z.string().nullable() }),
    target_account: z.looseObject({ username: z.string(), domain: z.string().nullable() }),
    statuses: z.array(z.looseObject({ uri: z.string().optional(), id: z.string() })),
  }),
);
const FiledReport = z.looseObject({ id: z.string(), forwarded: z.boolean() });
const SuspendedFlag = z.looseObject({ suspended: z.boolean().optional() });

const block = (user: E2eUser, accountId: string, action: "block" | "unblock") =>
  call(user, `/api/v1/accounts/${accountId}/${action}`, Anything, { method: "POST", body: {} });

const mentioned = async (user: E2eUser, uri: string): Promise<boolean> => {
  const list = await call(user, "/api/v1/notifications?types[]=mention&limit=40", Notifications);
  return list.some((item) => item.status?.uri === uri);
};

export const moderationScenarios = async ({ stamp, erin }: Cast): Promise<void> => {
  const alice = await signUp(A, "bea");
  const bob = await signUp(A, "ben");
  const tstodonModerator = await signUp(A, "moderator");
  const mastodonModerator = await mastodonUser("moderator");
  // A block that a failed step leaves in place must not outlive the run.
  const [mona] = await mastodonUsers([`blk_${stamp}`]);
  if (!mona) {
    throw new StepFailure("no Mastodon user");
  }

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays(
    "a block ends the follows both ways, and a new follow does not go through",
    alice,
    mona,
    async (from, to) => {
      const blockedId = (await resolveAccount(from, to)).id;
      const blockerId = (await resolveAccount(to, from)).id;
      await block(from, blockedId, "block");
      try {
        await relationshipBecomes(
          to,
          blockerId,
          "the blocked account follows no longer and is followed no longer",
          (state) => !state.following && !state.followed_by,
        );
        await call(to, `/api/v1/accounts/${blockerId}/follow`, Anything, {
          method: "POST",
          body: {},
        }).catch(() => undefined);
        await sleep(4000);
        const [blockedSide, blockerSide] = [
          await relationship(to, blockerId),
          await relationship(from, blockedId),
        ];
        if (blockedSide.following || blockerSide.followed_by) {
          throw new StepFailure(
            `the blocked account follows again: following ${String(blockedSide.following)} on its server, followed_by ${String(blockerSide.followed_by)} on the blocker's`,
          );
        }
      } finally {
        await block(from, blockedId, "unblock");
      }
      // The `Undo(Block)` is delivered, not applied at once: until it is,
      // the blocked side's server refuses a follow (Mastodon answers 403).
      await relationshipBecomes(
        to,
        blockerId,
        "the unblock arrived",
        (state) => state.blocked_by !== true,
      );
      // The refused follow may still read `requested` on the blocked side.
      await call(to, `/api/v1/accounts/${blockerId}/unfollow`, Anything, {
        method: "POST",
        body: {},
      });
      await follow(to, from);
      await follow(from, to);
    },
  );

  await bothWays(
    "a blocked account's mention does not notify the blocker",
    alice,
    mona,
    async (from, to) => {
      const blockedId = (await resolveAccount(from, to)).id;
      await block(from, blockedId, "block");
      try {
        const blockerId = (await resolveAccount(to, from)).id;
        await relationshipBecomes(to, blockerId, "the block arrived", (state) => !state.following);
        const sent = await post(to, { status: `${from.acct} from the blocked ${stamp}` });
        await sleep(5000);
        if (await mentioned(from, sent.uri)) {
          throw new StepFailure("the blocker was notified of the mention");
        }
      } finally {
        await block(from, blockedId, "unblock");
      }
      const after = await post(to, { status: `${from.acct} after the unblock ${stamp}` });
      await eventually("a mention after the unblock notifies", async () =>
        (await mentioned(from, after.uri)) ? true : undefined,
      );
    },
  );

  /** `reporter` reports `target` and one of its posts with `forward`; `moderator` finds the report. */
  const forwardedReport = async (
    reporter: E2eUser,
    target: E2eUser,
    moderator: E2eUser,
  ): Promise<void> => {
    const offending = await post(target, { status: `reportable ${stamp}` });
    const targetOnReporter = await resolveAccount(reporter, target);
    const copy = await resolveStatus(reporter, offending.uri);
    const comment = `spam, says ${reporter.username} ${stamp}`;
    const filed = await call(reporter, "/api/v1/reports", FiledReport, {
      method: "POST",
      body: {
        account_id: targetOnReporter.id,
        status_ids: [copy.id],
        comment,
        forward: true,
        category: "spam",
      },
    });
    if (!filed.forwarded) {
      throw new StepFailure("the report was filed with forwarded false");
    }
    const report = await eventually("the remote moderators have the report", async () => {
      const reports = await call(moderator, "/api/v1/admin/reports?limit=40", AdminReports);
      return reports.find((entry) => entry.comment === comment);
    });
    if (report.target_account.username !== target.username || report.target_account.domain) {
      throw new StepFailure(`the report targets ${JSON.stringify(report.target_account)}`);
    }
    if (report.statuses.length !== 1 || report.statuses[0]?.id !== offending.id) {
      throw new StepFailure(`the report's posts are ${JSON.stringify(report.statuses)}`);
    }
    // The reporter stays anonymous: the sending server's actor files the report.
    if (report.account.username === reporter.username) {
      throw new StepFailure("the report names the reporter");
    }
  };

  await step("a forwarded report reaches the remote moderators: tstodon → Mastodon", () =>
    forwardedReport(alice, erin, mastodonModerator),
  );
  await step("a forwarded report reaches the remote moderators: Mastodon → tstodon", async () => {
    await forwardedReport(mona, bob, await tstodonAdmin(tstodonModerator));
  });

  const moderate = (admin: E2eUser, accountId: string, action: "suspend" | "unsuspend") =>
    call(
      admin,
      action === "suspend"
        ? `/api/v1/admin/accounts/${accountId}/action`
        : `/api/v1/admin/accounts/${accountId}/unsuspend`,
      Anything,
      { method: "POST", body: action === "suspend" ? { type: "suspend" } : {} },
    );

  await step("a tstodon suspension reaches Mastodon, and so does lifting it", async () => {
    const admin = await tstodonAdmin(tstodonModerator);
    const suspended = await signUp(A, "susp");
    await follow(mona, suspended);
    const onMastodon = (await resolveAccount(mona, suspended)).id;
    const shownSuspended = async () =>
      (await call(mona, `/api/v1/accounts/${onMastodon}`, SuspendedFlag)).suspended === true;
    await moderate(admin, suspended.id, "suspend");
    await eventually("Mastodon shows the account suspended", async () =>
      (await shownSuspended()) ? true : undefined,
    );
    await moderate(admin, suspended.id, "unsuspend");
    await eventually("Mastodon shows the account again", async () =>
      (await shownSuspended()) ? undefined : true,
    );
  });

  await step("suspending a Mastodon account on tstodon ends its follow there", async () => {
    const admin = await tstodonAdmin(tstodonModerator);
    const [follower] = await mastodonUsers([`sus_${stamp}`]);
    if (!follower) {
      throw new StepFailure("no Mastodon user");
    }
    const followedId = await follow(follower, bob);
    const followerOnTstodon = (await resolveAccount(admin, follower)).id;
    await moderate(admin, followerOnTstodon, "suspend");
    try {
      await relationshipBecomes(
        follower,
        followedId,
        "Mastodon no longer shows the follow after the Reject",
        (state) => !state.following && !state.requested,
      );
    } finally {
      await moderate(admin, followerOnTstodon, "unsuspend");
    }
  });
};
