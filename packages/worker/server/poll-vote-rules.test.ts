import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";

const Poll = z.object({
  id: z.string(),
  voters_count: z.number().nullable(),
  own_votes: z.array(z.number()).optional(),
  options: z.array(z.object({ votes_count: z.number().nullable() })),
});
const Status = z.object({ poll: Poll });

const createPoll = async (email: string, multiple: boolean): Promise<string> => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({
      status: "vote please",
      poll: { options: ["cats", "dogs", "birds"], expires_in: 3600, multiple },
    }),
  });
  expect(response.status).toBe(200);
  return Status.parse(await response.json()).poll.id;
};

const Refusal = z.object({ error: z.string() });

const ballot = async (
  email: string,
  pollId: string,
  choices: number[],
): Promise<{ status: number; error: string | undefined }> => {
  const response = await SELF.fetch(`https://example.com/api/v1/polls/${pollId}/votes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ choices }),
  });
  const refusal = Refusal.safeParse(await response.json());
  return { status: response.status, error: refusal.success ? refusal.data.error : undefined };
};

const vote = async (email: string, pollId: string, choices: number[]): Promise<number> =>
  (await ballot(email, pollId, choices)).status;

const state = async (email: string, pollId: string) => {
  const response = await SELF.fetch(`https://example.com/api/v1/polls/${pollId}`, {
    headers: await authHeaders(email),
  });
  const poll = Poll.parse(await response.json());
  return {
    tallies: poll.options.map((option) => option.votes_count),
    voters: poll.voters_count,
    own: poll.own_votes,
  };
};

// Mastodon's `VoteValidator`: a refused vote answers 422 with
// "Validation failed: " and the validator's messages, joined by ", ".
describe("a local vote on a local poll", () => {
  it("takes one choice, once, on a single-choice poll", async () => {
    const poll = await createPoll("vote-rules-single-author@example.com", false);
    const voter = "vote-rules-single-voter@example.com";
    const greedy = "vote-rules-single-greedy@example.com";

    expect(await vote(voter, poll, [0])).toBe(200);
    expect(await vote(voter, poll, [1])).toBe(422);
    expect(await vote(voter, poll, [0])).toBe(422);
    expect(await vote(greedy, poll, [0, 1])).toBe(422);

    expect(await state(voter, poll)).toEqual({ tallies: [1, 0, 0], voters: 1, own: [0] });
    expect((await state(greedy, poll)).own).toEqual([]);
  });

  it("takes each choice once on a multiple-choice poll", async () => {
    const poll = await createPoll("vote-rules-multiple-author@example.com", true);
    const voter = "vote-rules-multiple-voter@example.com";

    expect(await vote(voter, poll, [0, 1])).toBe(200);
    expect(await vote(voter, poll, [1])).toBe(422);
    expect(await vote(voter, poll, [1, 2])).toBe(422);
    expect(await state(voter, poll)).toEqual({ tallies: [1, 1, 0], voters: 1, own: [0, 1] });

    expect(await vote(voter, poll, [2])).toBe(200);
    expect(await state(voter, poll)).toEqual({ tallies: [1, 1, 1], voters: 1, own: [0, 1, 2] });
  });

  it("refuses a vote on the account's own poll", async () => {
    const author = "vote-rules-own-author@example.com";
    const poll = await createPoll(author, false);

    expect(await ballot(author, poll, [0])).toEqual({
      status: 422,
      error: "Validation failed: You cannot vote in your own polls",
    });
    expect(await state(author, poll)).toEqual({ tallies: [0, 0, 0], voters: 0, own: [] });
  });

  it("refuses a choice the poll does not have", async () => {
    const author = "vote-rules-range-author@example.com";
    const poll = await createPoll(author, true);
    const voter = "vote-rules-range-voter@example.com";
    const missing = {
      status: 422,
      error: "Validation failed: The chosen vote option does not exist",
    };

    expect(await ballot(voter, poll, [3])).toEqual(missing);
    expect(await ballot(voter, poll, [-1])).toEqual(missing);
    // One refused choice refuses the ballot: the valid choice is not counted.
    expect(await ballot(voter, poll, [0, 3])).toEqual(missing);
    expect(await state(voter, poll)).toEqual({ tallies: [0, 0, 0], voters: 0, own: [] });

    // The validator reports every rule a vote breaks, in its own order.
    expect(await ballot(author, poll, [3])).toEqual({
      status: 422,
      error:
        "Validation failed: The chosen vote option does not exist, You cannot vote in your own polls",
    });
  });

  it("words a repeated vote as Mastodon does", async () => {
    const poll = await createPoll("vote-rules-words-author@example.com", false);
    const voter = "vote-rules-words-voter@example.com";
    const repeated = {
      status: 422,
      error: "Validation failed: You have already voted on this poll",
    };

    expect(await ballot(voter, poll, [0, 1])).toEqual(repeated);
    expect(await vote(voter, poll, [0])).toBe(200);
    expect(await ballot(voter, poll, [1])).toEqual(repeated);
  });
});
