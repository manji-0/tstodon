import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { OutboxJob } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { deliverTarget } from "../test/delivery-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
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
  uri: z.string(),
  account: z.object({ id: z.string(), username: z.string() }),
  poll: z.object({ id: z.string() }),
});

const createPoll = async (email: string, multiple = false, hideTotals = false) => {
  const response = await send(email, "/api/v1/statuses", {
    status: "poll",
    poll: { options: ["yes", "no"], expires_in: 3600, multiple, hide_totals: hideTotals },
  });
  expect(response.status).toBe(200);
  const posted = read(PostedPoll, response.body);
  return {
    statusId: posted.id,
    statusUri: posted.uri,
    pollId: posted.poll.id,
    authorId: posted.account.id,
    authorUsername: posted.account.username,
  };
};

const vote = async (email: string, pollId: string, choices: number[] = [0]) =>
  expect((await send(email, `/api/v1/polls/${pollId}/votes`, { choices })).status).toBe(200);

const endPoll = (pollId: string) =>
  env.DB.prepare("UPDATE polls SET expires_at = ? WHERE id = ?")
    .bind("2020-01-01T00:00:00.000Z", pollId)
    .run();

const runJob = async (on: Env, value: unknown) => {
  const job = OutboxJob.parse(value);
  if (job.isErr()) {
    throw new Error("outbox job rejected");
  }
  await processOutboxJob(on, job.value);
};

const runExpiryJob = (on: Env = env) => runJob(on, { kind: "ProcessExpiredPolls" });

/** The Worker's env with a queue that records each job sent to it. */
const recordingEnv = () => {
  const sent: unknown[] = [];
  const queue = {
    send: async (message: unknown) => {
      sent.push(message);
    },
    sendBatch: async (messages: ReadonlyArray<{ body: unknown }>) => {
      sent.push(...messages.map((message) => message.body));
    },
  };
  const proxied = new Proxy(env, {
    get: (target, key) => (key === "OUTBOX_PROCESS_QUEUE" ? queue : Reflect.get(target, key)),
  });
  return { env: proxied, sent };
};

const sentJobs = (sent: ReadonlyArray<unknown>, job: Record<string, unknown>) =>
  sent.filter((message) => JSON.stringify(message) === JSON.stringify(job));

const QuestionUpdate = z.object({
  type: z.literal("Update"),
  object: z.object({
    id: z.string(),
    type: z.literal("Question"),
    endTime: z.string(),
    closed: z.string().optional(),
    votersCount: z.number().optional(),
    oneOf: z.array(z.object({ name: z.string(), replies: z.object({ totalItems: z.number() }) })),
  }),
});

/** The `Update(Question)` activities queued for the author, oldest first. */
const questionUpdates = async (authorId: string) => {
  const rows = await env.DB.prepare(
    "SELECT id, payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid",
  )
    .bind(authorId)
    .all<{ id: string; payload_json: string }>();
  return rows.results.map((row) => ({
    activityId: row.id,
    activity: read(QuestionUpdate, JSON.parse(row.payload_json)),
  }));
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

describe("final counts of a local poll", () => {
  it("delivers one Update(Question) with the final counts to remote followers once it ends", async () => {
    const poll = await createPoll("local-poll-final-author@example.com");
    const fan = await remoteActor("poll-final-fan", "fans.example");
    expect(
      await fan.send({
        id: `${fan.actorUri}/follows/poll-final`,
        type: "Follow",
        object: `https://example.com/users/${poll.authorUsername}`,
      }),
    ).toBe(202);
    await vote("local-poll-final-voter@example.com", poll.pollId, [1]);
    // The vote's debounced Update has gone out by the time the poll ends.
    await runJob(env, { kind: "DistributePollUpdate", pollId: poll.pollId });
    const before = await questionUpdates(poll.authorId);

    await endPoll(poll.pollId);
    const recording = recordingEnv();
    await runExpiryJob(recording.env);
    await runExpiryJob(recording.env);
    const job = { kind: "DistributePollUpdate", pollId: poll.pollId };
    expect(sentJobs(recording.sent, job)).toHaveLength(1);

    await runJob(env, job);
    const [queued, ...extra] = (await questionUpdates(poll.authorId)).slice(before.length);
    expect(extra).toEqual([]);
    if (!queued) {
      throw new Error("no final Update queued");
    }
    await runJob(env, { kind: "ExpandFollowers", activityId: queued.activityId });
    const delivered = await deliverTarget(queued.activityId, `${fan.actorUri}/inbox`);
    expect(read(QuestionUpdate, await delivered.json()).object).toMatchObject({
      id: poll.statusUri,
      endTime: "2020-01-01T00:00:00.000Z",
      closed: "2020-01-01T00:00:00.000Z",
      votersCount: 1,
      oneOf: [
        { name: "yes", replies: { totalItems: 0 } },
        { name: "no", replies: { totalItems: 1 } },
      ],
    });
  });

  it("delivers the final Update(Question) to remote voters and boosters who do not follow the author, once per shared inbox", async () => {
    const poll = await createPoll("local-poll-final-reach@example.com");
    const actorUrl = `https://example.com/users/${poll.authorUsername}`;
    const sharedInboxUri = "https://voters.example/inbox";
    const voter = await remoteActor("poll-reach-voter", "voters.example", { sharedInboxUri });
    const neighbour = await remoteActor("poll-reach-neighbour", "voters.example", {
      sharedInboxUri,
    });
    const booster = await remoteActor("poll-reach-booster", "boosters.example");
    const voteUri = `${voter.actorUri}/notes/poll-reach-vote`;
    expect(
      await voter.send({
        id: `${voteUri}/activity`,
        type: "Create",
        to: [actorUrl],
        object: {
          id: voteUri,
          type: "Note",
          attributedTo: voter.actorUri,
          to: [actorUrl],
          inReplyTo: poll.statusUri,
          name: "yes",
        },
      }),
    ).toBe(202);
    for (const actor of [neighbour, booster]) {
      expect(
        await actor.send({
          id: `${actor.actorUri}/announces/poll-reach`,
          type: "Announce",
          to: ["https://www.w3.org/ns/activitystreams#Public"],
          cc: [`${actor.actorUri}/followers`],
          object: poll.statusUri,
        }),
      ).toBe(202);
    }
    await runJob(env, { kind: "DistributePollUpdate", pollId: poll.pollId });
    const before = await questionUpdates(poll.authorId);

    await endPoll(poll.pollId);
    await runExpiryJob();
    await runJob(env, { kind: "DistributePollUpdate", pollId: poll.pollId });
    const [queued] = (await questionUpdates(poll.authorId)).slice(before.length);
    if (!queued) {
      throw new Error("no final Update queued");
    }
    await runJob(env, { kind: "ExpandFollowers", activityId: queued.activityId });
    const targets = await env.DB.prepare(
      "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
    )
      .bind(queued.activityId)
      .all<{ inbox_url: string }>();
    expect(targets.results.map((row) => row.inbox_url)).toEqual([
      `${booster.actorUri}/inbox`,
      sharedInboxUri,
    ]);
    const delivered = await deliverTarget(queued.activityId, sharedInboxUri);
    expect(read(QuestionUpdate, await delivered.json()).object).toMatchObject({
      id: poll.statusUri,
      closed: "2020-01-01T00:00:00.000Z",
      votersCount: 1,
    });
  });

  it("federates the counts of a poll that hid them until it ended", async () => {
    const poll = await createPoll("local-poll-final-hidden@example.com", false, true);
    await vote("local-poll-final-hidden-voter@example.com", poll.pollId, [0]);
    await endPoll(poll.pollId);
    const recording = recordingEnv();
    await runExpiryJob(recording.env);
    const job = { kind: "DistributePollUpdate", pollId: poll.pollId };
    expect(sentJobs(recording.sent, job)).toHaveLength(1);

    await runJob(env, job);
    expect(
      (await questionUpdates(poll.authorId)).map((update) => update.activity.object),
    ).toMatchObject([
      {
        closed: "2020-01-01T00:00:00.000Z",
        votersCount: 1,
        oneOf: [{ replies: { totalItems: 1 } }, { replies: { totalItems: 0 } }],
      },
    ]);
  });
});

describe("a backlog of ended polls", () => {
  it("queues follow-up runs until every ended poll is announced, then stops", async () => {
    const author = "local-poll-backlog-author@example.com";
    await authHeaders(author);
    const polls = await Promise.all(Array.from({ length: 51 }, () => createPoll(author)));
    await Promise.all(polls.map((poll) => endPoll(poll.pollId)));
    const followUp = { kind: "ProcessExpiredPolls" };

    let run = recordingEnv();
    await runExpiryJob(run.env);
    expect(sentJobs(run.sent, followUp)).toHaveLength(1);
    for (let runs = 0; runs < 5 && sentJobs(run.sent, followUp).length > 0; runs += 1) {
      run = recordingEnv();
      await runExpiryJob(run.env);
    }
    expect(sentJobs(run.sent, followUp)).toEqual([]);

    const unannounced = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM polls WHERE expiry_notified_at IS NULL AND id IN (${polls.map(() => "?").join(", ")})`,
    )
      .bind(...polls.map((poll) => poll.pollId))
      .first("n");
    expect(unannounced).toBe(0);
  }, 60_000);
});
