/** Sweep area INT-8: an account that moves to the other server, and where its followers on each server end up. */
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Account,
  call,
  type Cast,
  follow,
  followsAfterAccept,
  mastodonRails,
  mastodonUsers,
  resolveAccount,
  step,
  StepFailure,
} from "./sweep.js";

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

export const moveScenarios = async ({ stamp }: Cast): Promise<void> => {
  const tstodonSource = await signUp(A, "mover");
  const tstodonTarget = await signUp(A, "newhome");
  const tstodonFan = await signUp(A, "fan");
  // A move is for good, and a moved account cannot move again for 30 days.
  const [mastodonSource, mastodonTarget, mastodonFan] = await mastodonUsers([
    `mover_${stamp}`,
    `newhome_${stamp}`,
    `fan_${stamp}`,
  ]);
  if (!mastodonSource || !mastodonTarget || !mastodonFan) {
    throw new StepFailure("no Mastodon users");
  }

  const ready = await step(
    "followers on both servers follow the two accounts that will move",
    async () => {
      for (const fan of [tstodonFan, mastodonFan]) {
        await follow(fan, tstodonSource);
        await follow(fan, mastodonSource);
      }
    },
  );
  if (!ready) {
    return;
  }

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
};
