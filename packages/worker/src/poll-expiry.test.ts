import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { OutboxJob } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { processOutboxJob } from "./outbox-job";
import { loadNotePoll, recordRemotePollVote } from "./poll-store";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const send = async (email: string, path: string, body: Record<string, unknown> = {}) =>
  json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });

const PostedPoll = z.object({
  id: z.string(),
  account: z.object({ id: z.string() }),
  poll: z.object({ id: z.string() }),
});

const createPoll = async (email: string, multiple = false) => {
  const response = await send(email, "/api/v1/statuses", {
    status: "poll",
    poll: { options: ["yes", "no"], expires_in: 3600, multiple },
  });
  expect(response.status).toBe(200);
  const posted = read(PostedPoll, response.body);
  return { statusId: posted.id, pollId: posted.poll.id, authorId: posted.account.id };
};

const vote = async (email: string, pollId: string, choices: number[] = [0]) =>
  expect((await send(email, `/api/v1/polls/${pollId}/votes`, { choices })).status).toBe(200);

const endPoll = (pollId: string) =>
  env.DB.prepare("UPDATE polls SET expires_at = ? WHERE id = ?")
    .bind("2020-01-01T00:00:00.000Z", pollId)
    .run();

const runExpiryJob = async () => {
  const job = OutboxJob.parse({ kind: "ProcessExpiredPolls" });
  if (job.isErr()) {
    throw new Error("expired polls job rejected");
  }
  await processOutboxJob(env, job.value);
};

const pollNotifications = async (email: string) =>
  read(
    z.array(
      z.object({
        type: z.string(),
        account: z.object({ id: z.string() }),
        status: z.object({ id: z.string() }),
      }),
    ),
    (await json("/api/v1/notifications?types[]=poll", { headers: await authHeaders(email) })).body,
  );

describe("local poll expiry notifications", () => {
  it("tells the author and each local voter once, from the author, after the poll ends", async () => {
    const author = "local-poll-expiry-author@example.com";
    const voter = "local-poll-expiry-voter@example.com";
    const multiVoter = "local-poll-expiry-multi@example.com";
    const bystander = "local-poll-expiry-bystander@example.com";
    await authHeaders(bystander);
    const poll = await createPoll(author, true);
    await vote(voter, poll.pollId);
    await vote(multiVoter, poll.pollId, [0, 1]);

    await runExpiryJob();
    expect(await pollNotifications(author)).toEqual([]);
    expect(await pollNotifications(voter)).toEqual([]);

    await endPoll(poll.pollId);
    // A redelivered job must not tell anyone twice.
    await runExpiryJob();
    await runExpiryJob();
    const expected = [
      { type: "poll", account: { id: poll.authorId }, status: { id: poll.statusId } },
    ];
    expect(await pollNotifications(author)).toMatchObject(expected);
    expect(await pollNotifications(voter)).toMatchObject(expected);
    expect(await pollNotifications(multiVoter)).toMatchObject(expected);
    expect(await pollNotifications(bystander)).toEqual([]);
  });

  it("tells an author who voted on their own poll once", async () => {
    const author = "local-poll-expiry-self@example.com";
    const poll = await createPoll(author);
    await vote(author, poll.pollId);
    await endPoll(poll.pollId);
    await runExpiryJob();
    await runExpiryJob();
    expect(await pollNotifications(author)).toHaveLength(1);
  });

  it("tells no voter who blocks the author or mutes their notifications", async () => {
    const author = "local-poll-expiry-blocked@example.com";
    const blocker = "local-poll-expiry-blocker@example.com";
    const muter = "local-poll-expiry-muter@example.com";
    const quietMuter = "local-poll-expiry-quiet-muter@example.com";
    const poll = await createPoll(author);
    for (const email of [blocker, muter, quietMuter]) {
      await vote(email, poll.pollId);
    }
    expect((await send(blocker, `/api/v1/accounts/${poll.authorId}/block`)).status).toBe(200);
    expect(
      (await send(muter, `/api/v1/accounts/${poll.authorId}/mute`, { notifications: true })).status,
    ).toBe(200);
    expect(
      (await send(quietMuter, `/api/v1/accounts/${poll.authorId}/mute`, { notifications: false }))
        .status,
    ).toBe(200);
    await endPoll(poll.pollId);
    await runExpiryJob();
    expect(await pollNotifications(blocker)).toEqual([]);
    expect(await pollNotifications(muter)).toEqual([]);
    expect(await pollNotifications(quietMuter)).toHaveLength(1);
  });

  it("is not held back by the recipient's notification policy", async () => {
    const author = "local-poll-expiry-policy@example.com";
    const voter = "local-poll-expiry-policy-voter@example.com";
    const poll = await createPoll(author);
    await vote(voter, poll.pollId);
    for (const email of [author, voter]) {
      const patched = await json("/api/v2/notifications/policy", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: JSON.stringify({ for_not_following: "filter", for_not_followers: "filter" }),
      });
      expect(patched.status).toBe(200);
    }
    await endPoll(poll.pollId);
    await runExpiryJob();
    expect(await pollNotifications(author)).toHaveLength(1);
    expect(await pollNotifications(voter)).toHaveLength(1);
  });

  it("keeps no trace of a vote refused because the poll ended while it was cast", async () => {
    const author = "local-poll-expiry-race-author@example.com";
    const voter = "local-poll-expiry-race-voter@example.com";
    const headers = await authHeaders(voter);
    const poll = await createPoll(author, true);
    await endPoll(poll.pollId);
    // The handler's early expiry check still sees the poll open; the write does not.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2019-12-31T23:59:00.000Z"));
    try {
      expect(
        (await send(voter, `/api/v1/polls/${poll.pollId}/votes`, { choices: [0] })).status,
      ).toBe(422);
    } finally {
      clock.mockRestore();
    }
    const fetched = await json(`/api/v1/polls/${poll.pollId}`, { headers });
    expect(
      read(z.object({ voted: z.boolean(), own_votes: z.array(z.number()) }), fetched.body),
    ).toMatchObject({ voted: false, own_votes: [] });
    await runExpiryJob();
    expect(await pollNotifications(voter)).toEqual([]);
  });

  it("counts no remote vote refused because the poll ended while it was cast", async () => {
    const poll = await createPoll("remote-poll-expiry-race-author@example.com");
    await endPoll(poll.pollId);
    const record = await loadNotePoll(env.DB, poll.statusId);
    if (!record) {
      throw new Error("poll not found");
    }
    // The store's early expiry check still sees the poll open; the write does not.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2019-12-31T23:59:00.000Z"));
    try {
      const recorded = await recordRemotePollVote(env.DB, record, {
        actorUri: "https://remote.example/users/late-voter",
        objectUri: "https://remote.example/users/late-voter/votes/1",
        title: "yes",
      });
      expect(recorded.isOk() && recorded.value.kind).toBe("Expired");
    } finally {
      clock.mockRestore();
    }
    const fetched = await json(`/api/v1/polls/${poll.pollId}`);
    expect(
      read(z.object({ votes_count: z.number(), voters_count: z.number() }), fetched.body),
    ).toMatchObject({ votes_count: 0, voters_count: 0 });
  });

  it("leaves no vote of an ended poll waiting to be announced, the author's own included", async () => {
    const author = "local-poll-pending-author@example.com";
    const voter = "local-poll-pending-voter@example.com";
    const poll = await createPoll(author, true);
    await vote(author, poll.pollId, [0, 1]);
    await vote(voter, poll.pollId, [1]);
    await endPoll(poll.pollId);
    await runExpiryJob();
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ? AND expiry_notified_at IS NULL",
    )
      .bind(poll.pollId)
      .first("n");
    expect(pending).toBe(0);
  });
});
