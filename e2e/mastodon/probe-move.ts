/**
 * Sweep area INT-8: an account that moves to the other server, where its
 * followers on each server end up, what its blockers and muters on each
 * server carry over to the new account, and the redirect cancelled.
 */
import { z } from "zod";
import { A, signUp, type E2eUser } from "../lib.js";
import { MASTODON } from "./lib.js";
import {
  Account,
  Accounts,
  Anything,
  call,
  type Cast,
  eventually,
  follow,
  followsAfterAccept,
  mastodonRails,
  mastodonUsers,
  resolveAccount,
  step,
  StepFailure,
} from "./sweep.js";

/** What a tstodon relationship tells about follows, blocks, mutes and notes. */
const Relationship = z.array(
  z.looseObject({
    following: z.boolean(),
    blocking: z.boolean(),
    muting: z.boolean(),
    muting_notifications: z.boolean(),
    note: z.string(),
  }),
);

/** Post a tstodon settings form with the user's browser session; the page it answers with. */
const postSettings = async (
  user: E2eUser,
  path: string,
  fields: Record<string, string>,
): Promise<string> => {
  const response = await user.browser(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  const page = await response.text();
  if (!response.ok) {
    throw new StepFailure(`POST ${path} → ${response.status} ${page.slice(0, 300)}`);
  }
  return page;
};

const bare = (user: E2eUser): string => user.acct.replace(/^@/, "");

/** `user`'s tstodon relationship to `accountId`. */
const tstodonRelationship = async (user: E2eUser, accountId: string) => {
  const [state] = await call(
    user,
    `/api/v1/accounts/relationships?id[]=${encodeURIComponent(accountId)}`,
    Relationship,
  );
  if (!state) {
    throw new StepFailure("no relationship");
  }
  return state;
};

/**
 * Whether `user` follows `accountId`. On Mastodon the following list says,
 * as its relationship answer is cached (see `followsAfterAccept`).
 */
const followsAccount = async (user: E2eUser, accountId: string): Promise<boolean> => {
  if (user.origin === MASTODON) {
    const following = await call(user, `/api/v1/accounts/${user.id}/following?limit=80`, Accounts);
    return following.some((account) => account.id === accountId);
  }
  return (await tstodonRelationship(user, accountId)).following;
};

/** `user` blocks `target`, or mutes it without hiding its notifications. */
const relate = async (user: E2eUser, target: E2eUser, kind: "block" | "mute"): Promise<void> => {
  const account = await resolveAccount(user, target);
  await call(user, `/api/v1/accounts/${account.id}/${kind}`, Anything, {
    method: "POST",
    body: kind === "mute" ? { notifications: false } : {},
  });
};

/**
 * `user` blocks or mutes `target` because it blocked or muted `source`. On
 * tstodon the relationship also says that the mute keeps its notifications
 * and carries the note the move leaves. On Mastodon the block and mute lists
 * say it, as its relationship answer is cached.
 */
const carriedOver = async (
  user: E2eUser,
  source: E2eUser,
  target: E2eUser,
  kind: "block" | "mute",
): Promise<void> => {
  const targetId = (await resolveAccount(user, target)).id;
  const label = `${user.username} ${kind}s ${target.acct}, as it did ${source.acct}`;
  if (user.origin === MASTODON) {
    await eventually(label, async () => {
      const listed = await call(user, `/api/v1/${kind}s?limit=80`, Accounts);
      return listed.some((account) => account.id === targetId) ? true : undefined;
    });
    return;
  }
  const state = await eventually(label, async () => {
    const found = await tstodonRelationship(user, targetId);
    return (kind === "block" ? found.blocking : found.muting) ? found : undefined;
  });
  const ending = kind === "block" ? "which you had blocked." : "which you had muted.";
  if (
    !state.note.startsWith(`This user moved from ${source.username}`) ||
    !state.note.endsWith(ending)
  ) {
    throw new StepFailure(
      `${user.username}'s note on ${target.acct} is ${JSON.stringify(state.note)}`,
    );
  }
  if (kind === "mute" && state.muting_notifications) {
    throw new StepFailure(`${user.username}'s carried mute hides notifications`);
  }
};

/** `follower` ends up following `target`, and its server shows `source` as moved there. */
const followsTheMove = async (
  follower: E2eUser,
  source: E2eUser,
  target: E2eUser,
): Promise<void> => {
  const targetId = (await resolveAccount(follower, target)).id;
  await followsAfterAccept(follower, targetId, `${follower.acct} follows ${target.acct}`);
  const sourceId = (await resolveAccount(follower, source)).id;
  const moved = (await call(follower, `/api/v1/accounts/${sourceId}`, Account)).moved;
  if (moved?.uri !== target.uri) {
    throw new StepFailure(
      `${follower.username}'s server shows ${source.acct} as moved to ${String(moved?.uri)}`,
    );
  }
};

/**
 * `viewer`'s server stops showing `source` as moved, and `follower` stays
 * with `target`: a cancelled redirect moves no one back.
 */
const redirectGone = async (
  viewer: E2eUser,
  follower: E2eUser,
  source: E2eUser,
  target: E2eUser,
): Promise<void> => {
  const sourceId = (await resolveAccount(viewer, source)).id;
  await eventually(
    `${viewer.username}'s server stops showing ${source.acct} as moved`,
    async () => {
      const account = await call(viewer, `/api/v1/accounts/${sourceId}`, Account);
      return account.moved ? undefined : true;
    },
  );
  const fromId = (await resolveAccount(follower, source)).id;
  const toId = (await resolveAccount(follower, target)).id;
  if ((await followsAccount(follower, fromId)) || !(await followsAccount(follower, toId))) {
    throw new StepFailure(`${follower.username} did not stay with ${target.acct}`);
  }
};

export const moveScenarios = async ({ stamp }: Cast): Promise<void> => {
  const tstodonSource = await signUp(A, "mover");
  const tstodonTarget = await signUp(A, "newhome");
  const tstodonFan = await signUp(A, "fan");
  const tstodonBlocker = await signUp(A, "blocker");
  const tstodonMuter = await signUp(A, "muter");
  const tstodonStayer = await signUp(A, "stayer");
  // A move is for good, and a moved account cannot move again for 30 days.
  const [
    mastodonSource,
    mastodonTarget,
    mastodonFan,
    mastodonBlocker,
    mastodonMuter,
    mastodonStayer,
  ] = await mastodonUsers([
    `mover_${stamp}`,
    `newhome_${stamp}`,
    `fan_${stamp}`,
    `blocker_${stamp}`,
    `muter_${stamp}`,
    `stayer_${stamp}`,
  ]);
  if (
    !mastodonSource ||
    !mastodonTarget ||
    !mastodonFan ||
    !mastodonBlocker ||
    !mastodonMuter ||
    !mastodonStayer
  ) {
    throw new StepFailure("no Mastodon users");
  }

  const ready = await step(
    "followers, blockers and muters on both servers of the two accounts that will move",
    async () => {
      for (const fan of [tstodonFan, mastodonFan]) {
        await follow(fan, tstodonSource);
        await follow(fan, mastodonSource);
      }
      for (const source of [tstodonSource, mastodonSource]) {
        for (const blocker of [tstodonBlocker, mastodonBlocker]) {
          await relate(blocker, source, "block");
        }
        for (const muter of [tstodonMuter, mastodonMuter]) {
          await relate(muter, source, "mute");
        }
      }
      // A follower who blocks the new account keeps following the old one on
      // both servers, so the old account's server still has a follower on the
      // other one to tell when the redirect is cancelled.
      await follow(tstodonStayer, mastodonSource);
      await relate(tstodonStayer, tstodonTarget, "block");
      await follow(mastodonStayer, tstodonSource);
      await relate(mastodonStayer, mastodonTarget, "block");
    },
  );
  if (!ready) {
    return;
  }

  /** Each server's blocker and muter of `source` block and mute `target`. */
  const carried = async (source: E2eUser, target: E2eUser): Promise<void> => {
    for (const user of [tstodonBlocker, mastodonBlocker]) {
      await carriedOver(user, source, target, "block");
    }
    for (const user of [tstodonMuter, mastodonMuter]) {
      await carriedOver(user, source, target, "mute");
    }
  };

  await step("an account moves and its followers follow: Mastodon → tstodon", async () => {
    const aliases = await postSettings(tstodonTarget, "/settings/aliases", {
      acct: mastodonSource.acct,
    });
    if (!aliases.includes(mastodonSource.username)) {
      throw new StepFailure("tstodon's alias page does not list the Mastodon account");
    }
    // What Mastodon's migration page runs, less the password check.
    mastodonRails(`
      source = Account.find_local(${JSON.stringify(mastodonSource.username)})
      migration = source.migrations.create!(acct: ${JSON.stringify(bare(tstodonTarget))})
      MoveService.new.call(migration)
    `);
    await followsTheMove(mastodonFan, mastodonSource, tstodonTarget);
    await followsTheMove(tstodonFan, mastodonSource, tstodonTarget);
  });

  await step("blocks and mutes are carried to the new account: Mastodon → tstodon", () =>
    carried(mastodonSource, tstodonTarget),
  );

  await step("an account moves and its followers follow: tstodon → Mastodon", async () => {
    // Mastodon's alias page, which has no API.
    mastodonRails(`
      target = Account.find_local(${JSON.stringify(mastodonTarget.username)})
      target.aliases.create!(acct: ${JSON.stringify(bare(tstodonSource))})
    `);
    const moved = await postSettings(tstodonSource, "/settings/migration", {
      acct: mastodonTarget.acct,
    });
    if (!moved.includes("Your followers are moving to")) {
      throw new StepFailure(
        `tstodon's migration page did not confirm the move: ${moved.slice(0, 300)}`,
      );
    }
    await followsTheMove(tstodonFan, tstodonSource, mastodonTarget);
    await followsTheMove(mastodonFan, tstodonSource, mastodonTarget);
  });

  await step("blocks and mutes are carried to the new account: tstodon → Mastodon", () =>
    carried(tstodonSource, mastodonTarget),
  );

  await step("a cancelled redirect moves no follower back: Mastodon → tstodon", async () => {
    // What Mastodon's `Settings::Migration::RedirectsController#destroy` runs.
    mastodonRails(`
      source = Account.find_local(${JSON.stringify(mastodonSource.username)})
      source.update!(moved_to_account: nil)
      ActivityPub::UpdateDistributionWorker.perform_async(source.id)
    `);
    await redirectGone(tstodonStayer, tstodonFan, mastodonSource, tstodonTarget);
  });

  await step("a cancelled redirect moves no follower back: tstodon → Mastodon", async () => {
    const cancelled = await postSettings(tstodonSource, "/settings/migration/cancel", {});
    if (!cancelled.includes("The redirect is cancelled")) {
      throw new StepFailure(`tstodon's migration page did not cancel: ${cancelled.slice(0, 300)}`);
    }
    await redirectGone(mastodonStayer, mastodonFan, tstodonSource, mastodonTarget);
  });
};
