/** Sweep area INT-10: multiple-choice polls, votes from strangers, tallies after a vote elsewhere, and a poll that ends. */
import { A, signUp, type E2eUser } from "../lib.js";
import {
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  mastodonRails,
  notified,
  onHome,
  Poll,
  post,
  resolveStatus,
  Status,
  step,
  StepFailure,
} from "./sweep.js";

const tallies = (poll: Poll | null | undefined): string =>
  poll ? poll.options.map((option) => option.votes_count ?? "-").join() : "no poll";

/** `viewer`'s copy of a poll, once `accept` takes it; a timeout reports the last tallies seen. */
const pollBecomes = async (
  viewer: E2eUser,
  statusId: string,
  label: string,
  accept: (poll: Poll) => boolean,
  timeoutMs = 20_000,
): Promise<Poll> => {
  let last = "";
  try {
    return await eventually(
      label,
      async () => {
        const { poll } = await call(viewer, `/api/v1/statuses/${statusId}`, Status);
        last = `${tallies(poll)} of ${poll?.votes_count ?? "?"} votes, ${poll?.voters_count ?? "?"} voters, expired ${poll?.expired ?? "?"}`;
        return poll && accept(poll) ? poll : undefined;
      },
      timeoutMs,
    );
  } catch (error) {
    throw new StepFailure(`${error instanceof Error ? error.message : String(error)}; saw ${last}`);
  }
};

const vote = (voter: E2eUser, pollId: string, choices: readonly number[]): Promise<Poll> =>
  call(voter, `/api/v1/polls/${pollId}/votes`, Poll, { method: "POST", body: { choices } });

export const pollScenarios = async ({ stamp, mona, carol }: Cast): Promise<void> => {
  const alice = await signUp(A, "paula");
  const bob = await signUp(A, "pablo");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await bothWays(
    "a multiple-choice poll takes two choices from a remote voter",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, {
        status: `multiple ${stamp}`,
        poll: { options: ["red", "green", "blue"], expires_in: 3600, multiple: true },
      });
      const copy = await onHome(to, sent.uri);
      if (!copy.poll?.multiple) {
        throw new StepFailure(`the copy's poll is not multiple: ${JSON.stringify(copy.poll)}`);
      }
      const voted = await vote(to, copy.poll.id, [0, 2]);
      if (!voted.voted || voted.own_votes?.join() !== "0,2") {
        throw new StepFailure(
          `the voter's server answers voted ${String(voted.voted)}, own_votes ${String(voted.own_votes)}`,
        );
      }
      await pollBecomes(
        from,
        sent.id,
        "the author's server counts both choices of one voter",
        (poll) => tallies(poll) === "1,0,1" && poll.votes_count === 2 && poll.voters_count === 1,
      );
      await pollBecomes(
        to,
        copy.id,
        "the voter's server shows its own two choices",
        (poll) => tallies(poll) === "1,0,1" && poll.voted === true,
      );
    },
  );

  await bothWays(
    "a second vote for one choice of a single-choice poll is refused",
    alice,
    mona,
    async (from, to) => {
      const sent = await post(from, {
        status: `single ${stamp}`,
        poll: { options: ["yes", "no"], expires_in: 3600 },
      });
      const copy = await onHome(to, sent.uri);
      if (!copy.poll || copy.poll.multiple) {
        throw new StepFailure(`the copy's poll is ${JSON.stringify(copy.poll)}`);
      }
      await vote(to, copy.poll.id, [0]);
      const again = await fetch(`${to.origin}/api/v1/polls/${copy.poll.id}/votes`, {
        method: "POST",
        headers: { ...to.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ choices: [1] }),
      });
      await again.arrayBuffer();
      if (again.status !== 422) {
        throw new StepFailure(`a second vote answers ${again.status}, not 422`);
      }
      await pollBecomes(
        from,
        sent.id,
        "the author's server counts one vote",
        (poll) => tallies(poll) === "1,0",
      );
    },
  );

  await bothWays(
    "a stranger who looked the poll up by URL votes",
    alice,
    mona,
    async (from, to) => {
      const stranger = to === alice ? bob : carol;
      const sent = await post(from, {
        status: `open poll ${stamp}`,
        poll: { options: ["tea", "coffee"], expires_in: 3600 },
      });
      const copy = await resolveStatus(stranger, sent.uri);
      if (!copy.poll) {
        throw new StepFailure("the resolved copy has no poll");
      }
      await vote(stranger, copy.poll.id, [1]);
      await pollBecomes(
        from,
        sent.id,
        "the author's server counts the stranger's vote",
        (poll) => tallies(poll) === "0,1",
      );
    },
  );

  // Mastodon sends the tallies three minutes after a vote
  // (`DistributePollUpdateWorker`), so only tstodon's `Update` is awaited here.
  await step(
    "a vote on the author's server reaches the remote copy: tstodon → Mastodon",
    async () => {
      const sent = await post(alice, {
        status: `tallied ${stamp}`,
        poll: { options: ["one", "two"], expires_in: 3600 },
      });
      const copy = await onHome(mona, sent.uri);
      const local = await call(bob, `/api/v1/statuses/${sent.id}`, Status);
      await vote(bob, local.poll?.id ?? "", [1]);
      await pollBecomes(
        mona,
        copy.id,
        "the copy has the vote cast on the author's server",
        (poll) => tallies(poll) === "0,1",
        30_000,
      );
    },
  );

  await step("a poll that ends is closed on the voter's server: Mastodon → tstodon", async () => {
    const sent = await post(mona, {
      status: `ending ${stamp}`,
      poll: { options: ["now", "later"], expires_in: 300 },
    });
    const copy = await onHome(alice, sent.uri);
    await vote(alice, copy.poll?.id ?? "", [0]);
    await pollBecomes(
      mona,
      sent.id,
      "the author's server counts the vote",
      (poll) => tallies(poll) === "1,0",
    );
    // Mastodon's shortest poll runs five minutes. End this one now and run
    // what Mastodon runs when a poll ends: the closing `Update`, and the
    // notifications. Both jobs are queued once per poll (the vote queued an
    // `Update` three minutes out), so they run here, not through Sidekiq.
    mastodonRails(`
      poll = Status.find(${JSON.stringify(sent.id)}).poll
      poll.update_columns(expires_at: 1.second.from_now)
      sleep 2
      ActivityPub::DistributePollUpdateWorker.new.perform(poll.status_id)
      PollExpirationNotifyWorker.new.perform(poll.id)
    `);
    await pollBecomes(
      alice,
      copy.id,
      "the voter's copy is expired, with the final tallies",
      (poll) => poll.expired && tallies(poll) === "1,0",
      40_000,
    );
    const late = await fetch(`${alice.origin}/api/v1/polls/${copy.poll?.id ?? ""}/votes`, {
      method: "POST",
      headers: { ...alice.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ choices: [1] }),
    });
    await late.arrayBuffer();
    if (late.status !== 422) {
      throw new StepFailure(`a vote on the ended poll answers ${late.status}, not 422`);
    }
    await notified(mona, "poll", mona, sent.uri);
  });
};
