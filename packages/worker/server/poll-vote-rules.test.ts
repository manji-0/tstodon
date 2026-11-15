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

const vote = async (email: string, pollId: string, choices: number[]): Promise<number> => {
  const response = await SELF.fetch(`https://example.com/api/v1/polls/${pollId}/votes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ choices }),
  });
  await response.arrayBuffer();
  return response.status;
};

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

// Mastodon's `VoteValidator`: "You have already voted on this poll", 422.
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
});
