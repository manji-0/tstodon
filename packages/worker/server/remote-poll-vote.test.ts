import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { OutboxJob } from "@tstodon/domain";
import { findRemoteActorsByUris } from "./remote-actor-store";
import { handleRemotePollVote } from "./remote-poll-vote";
import { processOutboxJob } from "./outbox-job";
import { parseInstanceIdentity } from "./runtime-config";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const PollSchema = z.object({
  id: z.string(),
  multiple: z.boolean(),
  votes_count: z.number().nullable(),
  voters_count: z.number().nullable(),
  options: z.array(z.object({ title: z.string(), votes_count: z.number().nullable() })),
});

const StatusSchema = z.object({
  id: z.string(),
  uri: z.string(),
  account: z.object({ id: z.string() }),
  poll: PollSchema,
});

type LocalPoll = Readonly<{
  statusId: string;
  statusUri: string;
  authorId: string;
  authorActor: string;
  pollId: string;
}>;

const createPoll = async (
  email: string,
  poll: Record<string, unknown> = {},
  visibility = "public",
): Promise<LocalPoll> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({
      status: "vote please",
      visibility,
      poll: { options: ["cats", "dogs", "birds"], expires_in: 3600, ...poll },
    }),
  });
  expect(response.status).toBe(200);
  const status = read(StatusSchema, response.body);
  return {
    statusId: status.id,
    statusUri: status.uri,
    authorId: status.account.id,
    authorActor: new URL(status.uri).pathname.split("/statuses/")[0] ?? "",
    pollId: status.poll.id,
  };
};

const actorUrl = (poll: LocalPoll): string => `https://example.com${poll.authorActor}`;

let voteSeq = 0;

/** A vote as Mastodon sends it: a content-less `Note` named for the option. */
const castVote = (voter: Remote, poll: LocalPoll, title: string, id?: string): Promise<number> => {
  voteSeq += 1;
  const objectId = id ?? `https://remote.example/votes/${voteSeq}`;
  return voter.send({
    id: `${objectId}/activity`,
    type: "Create",
    to: [actorUrl(poll)],
    object: {
      id: objectId,
      type: "Note",
      attributedTo: voter.actorUri,
      to: [actorUrl(poll)],
      inReplyTo: poll.statusUri,
      name: title,
    },
  });
};

const pollState = async (poll: LocalPoll) =>
  read(PollSchema, (await json(`/api/v1/polls/${poll.pollId}`)).body);

const count = async (sql: string, ...binds: string[]): Promise<number> =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? -1;

const JsonObject = z.record(z.string(), z.unknown());

const updates = async (poll: LocalPoll): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const rows = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid",
  )
    .bind(poll.authorId)
    .all<{ payload_json: string }>();
  return rows.results.map((row) => JsonObject.parse(JSON.parse(row.payload_json)));
};

describe("remote votes on a local poll", () => {
  it("serves a poll note as a Question with options and counts", async () => {
    const poll = await createPoll("question-author@example.com", { multiple: true });
    const response = await SELF.fetch(`https://example.com${new URL(poll.statusUri).pathname}`, {
      headers: { accept: "application/activity+json" },
    });
    expect(response.status).toBe(200);
    const note = JsonObject.parse(await response.json());
    expect(note).toMatchObject({
      type: "Question",
      anyOf: [
        { type: "Note", name: "cats", replies: { type: "Collection", totalItems: 0 } },
        { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: 0 } },
        { type: "Note", name: "birds", replies: { type: "Collection", totalItems: 0 } },
      ],
      votersCount: 0,
    });
    expect(note.oneOf).toBeUndefined();
    expect(note.closed).toBeUndefined();
    expect(typeof note.endTime).toBe("string");
    expect(JSON.stringify(note["@context"])).toContain("votersCount");
  });

  it("serves a single-choice poll as oneOf and a Create that carries the Question", async () => {
    const poll = await createPoll("oneof-author@example.com");
    const note = JsonObject.parse(
      await (await SELF.fetch(`https://example.com${new URL(poll.statusUri).pathname}`)).json(),
    );
    expect(note.type).toBe("Question");
    expect(note.anyOf).toBeUndefined();
    expect(Array.isArray(note.oneOf)).toBe(true);

    const created = await env.DB.prepare(
      "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Create'",
    )
      .bind(poll.authorId)
      .first<{ payload_json: string }>();
    const activity = z
      .object({ object: z.object({ type: z.string().optional() }).optional() })
      .parse(JSON.parse(created?.payload_json ?? "{}"));
    expect(activity.object?.type).toBe("Question");
  });

  it("counts a remote vote without storing a status or notifying", async () => {
    const poll = await createPoll("count-author@example.com");
    const voter = await remoteActor("count-voter");
    const notifications = await count(
      "SELECT COUNT(*) AS n FROM notifications WHERE account_id = ?",
      poll.authorId,
    );

    expect(await castVote(voter, poll, "dogs")).toBe(202);

    const state = await pollState(poll);
    expect(state.votes_count).toBe(1);
    expect(state.voters_count).toBe(1);
    expect(state.options.map((option) => option.votes_count)).toEqual([0, 1, 0]);
    expect(
      await count("SELECT COUNT(*) AS n FROM remote_statuses WHERE actor_uri = ?", voter.actorUri),
    ).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS n FROM notifications WHERE account_id = ?", poll.authorId),
    ).toBe(notifications);

    const refreshed = read(StatusSchema, (await json(`/api/v1/statuses/${poll.statusId}`)).body);
    expect(refreshed.poll.votes_count).toBe(1);
  });

  it("ignores a repeated vote", async () => {
    const poll = await createPoll("dup-author@example.com");
    const voter = await remoteActor("dup-voter");
    const objectId = "https://remote.example/votes/dup";

    expect(await castVote(voter, poll, "cats", objectId)).toBe(202);
    expect(await castVote(voter, poll, "cats", objectId)).toBe(202);
    expect(await castVote(voter, poll, "cats")).toBe(202);

    const state = await pollState(poll);
    expect(state.votes_count).toBe(1);
    expect(state.voters_count).toBe(1);
  });

  it("ignores a vote on an expired poll", async () => {
    const poll = await createPoll("expired-author@example.com");
    const voter = await remoteActor("expired-voter");
    await env.DB.prepare("UPDATE polls SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .bind(poll.pollId)
      .run();

    expect(await castVote(voter, poll, "cats")).toBe(202);

    expect((await pollState(poll)).votes_count).toBe(0);
  });

  it("ignores a vote for an option the poll does not have", async () => {
    const poll = await createPoll("unknown-author@example.com");
    const voter = await remoteActor("unknown-voter");

    expect(await castVote(voter, poll, "fish")).toBe(202);

    expect((await pollState(poll)).votes_count).toBe(0);
  });

  it("accepts two options on a multiple-choice poll", async () => {
    const poll = await createPoll("multi-author@example.com", { multiple: true });
    const voter = await remoteActor("multi-voter");
    const other = await remoteActor("multi-other");

    expect(await castVote(voter, poll, "cats")).toBe(202);
    expect(await castVote(voter, poll, "birds")).toBe(202);
    expect(await castVote(other, poll, "birds")).toBe(202);

    const state = await pollState(poll);
    expect(state.votes_count).toBe(3);
    expect(state.voters_count).toBe(2);
    expect(state.options.map((option) => option.votes_count)).toEqual([1, 0, 2]);
  });

  it("rejects a second option on a single-choice poll", async () => {
    const poll = await createPoll("single-author@example.com");
    const voter = await remoteActor("single-voter");

    expect(await castVote(voter, poll, "cats")).toBe(202);
    expect(await castVote(voter, poll, "dogs")).toBe(202);

    const state = await pollState(poll);
    expect(state.votes_count).toBe(1);
    expect(state.options.map((option) => option.votes_count)).toEqual([1, 0, 0]);
  });

  it("ignores a vote on a followers-only poll from a non-follower", async () => {
    const poll = await createPoll("private-author@example.com", {}, "private");
    const voter = await remoteActor("private-voter");

    expect(await castVote(voter, poll, "cats")).toBe(202);

    expect((await pollState(poll)).votes_count).toBe(0);
  });

  it("counts a vote on a followers-only poll from an accepted follower", async () => {
    const poll = await createPoll("follower-author@example.com", {}, "private");
    const voter = await remoteActor("follower-voter");
    await env.DB.prepare(
      `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
       VALUES ('poll-vote-follow', ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
    )
      .bind(voter.actorUri, poll.authorId)
      .run();

    expect(await castVote(voter, poll, "dogs")).toBe(202);

    expect((await pollState(poll)).votes_count).toBe(1);
  });
});

type QueueSend = Readonly<{ message: unknown; options: unknown }>;

/** The Worker's env with a queue that records what is sent to it. */
const recordingEnv = (fail = false, vars: Readonly<Record<string, string>> = {}) => {
  const sent: QueueSend[] = [];
  const queue = {
    send: async (message: unknown, options?: unknown) => {
      if (fail) {
        throw new Error("queue unavailable");
      }
      sent.push({ message, options });
    },
  };
  const proxied = new Proxy(env, {
    get: (target, key) =>
      key === "OUTBOX_PROCESS_QUEUE"
        ? queue
        : typeof key === "string" && key in vars
          ? vars[key]
          : Reflect.get(target, key),
  });
  return { env: proxied, sent };
};

/** A remote vote handled in-process, so the queue send can be observed. */
const handleVote = async (
  recording: Readonly<{ env: Env }>,
  voter: Remote,
  poll: LocalPoll,
  title: string,
): Promise<void> => {
  voteSeq += 1;
  const identity = parseInstanceIdentity(env);
  const actors = await findRemoteActorsByUris(env.DB, [voter.actorUri]);
  const actor = actors.isOk() ? actors.value.get(voter.actorUri) : undefined;
  if (identity.isErr() || !actor) {
    throw new Error("vote fixture rejected");
  }
  const outcome = await handleRemotePollVote(recording.env, identity.value, actor, {
    id: `https://remote.example/votes/direct-${voteSeq}`,
    type: "Note",
    attributedTo: voter.actorUri,
    to: [actorUrl(poll)],
    inReplyTo: poll.statusUri,
    name: title,
  });
  expect(outcome.isOk() ? outcome.value.kind : outcome.error.message).toBe("Recorded");
};

const runUpdateJob = async (poll: LocalPoll): Promise<void> => {
  const job = OutboxJob.parse({ kind: "DistributePollUpdate", pollId: poll.pollId });
  if (job.isErr()) {
    throw new Error("job rejected");
  }
  expect(await processOutboxJob(env, job.value)).toBe("ok");
};

const queuedAt = async (poll: LocalPoll): Promise<string | null | undefined> =>
  (
    await env.DB.prepare("SELECT update_queued_at FROM polls WHERE id = ?")
      .bind(poll.pollId)
      .first<{ update_queued_at: string | null }>()
  )?.update_queued_at;

describe("Update of the Question after votes", () => {
  it("waits POLL_UPDATE_DELAY_SECONDS when the instance sets it", async () => {
    const poll = await createPoll("short-delay-author@example.com");
    const recording = recordingEnv(false, { POLL_UPDATE_DELAY_SECONDS: "5" });
    await handleVote(recording, await remoteActor("short-delay-voter"), poll, "cats");

    expect(recording.sent).toEqual([
      {
        message: { kind: "DistributePollUpdate", pollId: poll.pollId },
        options: { delaySeconds: 5 },
      },
    ]);
  });

  it("queues one delayed job for a burst of votes", async () => {
    const poll = await createPoll("burst-author@example.com");
    const recording = recordingEnv();
    for (const [name, title] of [
      ["burst-a", "cats"],
      ["burst-b", "dogs"],
      ["burst-c", "dogs"],
    ] as const) {
      await handleVote(recording, await remoteActor(name), poll, title);
    }

    expect(recording.sent).toEqual([
      {
        message: { kind: "DistributePollUpdate", pollId: poll.pollId },
        options: { delaySeconds: 180 },
      },
    ]);
    expect(await updates(poll)).toHaveLength(0);
    expect((await pollState(poll)).votes_count).toBe(3);
  });

  it("federates one Update with every vote counted, then lets the next vote queue again", async () => {
    const poll = await createPoll("job-author@example.com");
    const recording = recordingEnv();
    await handleVote(recording, await remoteActor("job-a"), poll, "cats");
    await handleVote(recording, await remoteActor("job-b"), poll, "dogs");
    await handleVote(recording, await remoteActor("job-c"), poll, "dogs");
    expect(await queuedAt(poll)).toEqual(expect.any(String));

    await runUpdateJob(poll);

    expect(await queuedAt(poll)).toBeNull();
    const federated = await updates(poll);
    expect(federated).toHaveLength(1);
    expect(federated[0]).toMatchObject({
      type: "Update",
      actor: actorUrl(poll),
      object: {
        id: poll.statusUri,
        type: "Question",
        votersCount: 3,
        oneOf: [
          { name: "cats", replies: { totalItems: 1 } },
          { name: "dogs", replies: { totalItems: 2 } },
          { name: "birds", replies: { totalItems: 0 } },
        ],
      },
    });

    await handleVote(recording, await remoteActor("job-d"), poll, "birds");
    expect(recording.sent).toHaveLength(2);
    expect(await updates(poll)).toHaveLength(1);
    await runUpdateJob(poll);
    expect(await updates(poll)).toHaveLength(2);
  });

  it("queues nothing for a poll that hides its totals", async () => {
    const poll = await createPoll("hidden-author@example.com", { hide_totals: true });
    const recording = recordingEnv();

    await handleVote(recording, await remoteActor("hidden-a"), poll, "cats");
    expect(recording.sent).toHaveLength(0);
    expect(await queuedAt(poll)).toBeNull();

    await runUpdateJob(poll);
    expect(await updates(poll)).toHaveLength(0);
  });

  it("frees the slot when the queue refuses the job", async () => {
    const poll = await createPoll("refused-author@example.com");
    const refusing = recordingEnv(true);
    const working = recordingEnv();

    await handleVote(refusing, await remoteActor("refused-a"), poll, "cats");
    expect(await queuedAt(poll)).toBeNull();

    await handleVote(working, await remoteActor("refused-b"), poll, "dogs");
    expect(working.sent).toHaveLength(1);
  });

  it("takes over a claim whose job was lost", async () => {
    const poll = await createPoll("stale-author@example.com");
    await env.DB.prepare("UPDATE polls SET update_queued_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60 * 60 * 1000).toISOString(), poll.pollId)
      .run();
    const recording = recordingEnv();

    await handleVote(recording, await remoteActor("stale-a"), poll, "cats");
    expect(recording.sent).toHaveLength(1);
  });

  it("drops a job for a poll that no longer exists", async () => {
    const job = OutboxJob.parse({ kind: "DistributePollUpdate", pollId: "no-such-poll" });
    expect(job.isOk()).toBe(true);
    if (job.isOk()) {
      expect(await processOutboxJob(env, job.value)).toBe("ok");
    }
  });

  it("queues a job for a vote cast by a local account", async () => {
    const poll = await createPoll("local-author@example.com");
    expect(await queuedAt(poll)).toBeNull();

    const voted = await json(`/api/v1/polls/${poll.pollId}/votes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("local-voter@example.com")),
      },
      body: JSON.stringify({ choices: [1] }),
    });

    expect(voted.status).toBe(200);
    expect(await queuedAt(poll)).toEqual(expect.any(String));
    await runUpdateJob(poll);
    expect((await updates(poll))[0]).toMatchObject({
      object: { votersCount: 1, oneOf: [{}, { replies: { totalItems: 1 } }, {}] },
    });
  });
});

describe("a remote vote whose storage failed", () => {
  it("answers a server error when the vote cannot be written, and counts it once when it is redelivered", async () => {
    const poll = await createPoll("retry-vote-author@example.com");
    const voter = await remoteActor("retry-vote-voter");
    const objectId = "https://remote.example/votes/retry-vote";

    await env.DB.prepare(
      `CREATE TRIGGER poll_vote_retry_insert BEFORE INSERT ON remote_poll_votes
       WHEN NEW.object_uri = '${objectId}' BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
    ).run();
    try {
      expect(await castVote(voter, poll, "dogs", objectId)).toBe(500);
      expect((await pollState(poll)).votes_count).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER poll_vote_retry_insert").run();
    }

    expect(await castVote(voter, poll, "dogs", objectId)).toBe(202);
    // A new activity id, so the inbox does not drop it as seen: the vote itself is found counted.
    expect(await castVote(voter, poll, "dogs")).toBe(202);
    const state = await pollState(poll);
    expect(state.options.map((option) => option.votes_count)).toEqual([0, 1, 0]);
    expect(state.voters_count).toBe(1);
  });

  /** A vote some servers send with empty content and a date, which is also a note that parses. */
  const datedVote = (voter: Remote, poll: LocalPoll, objectId: string) => ({
    id: `${objectId}/activity`,
    type: "Create",
    to: [actorUrl(poll)],
    object: {
      id: objectId,
      type: "Note",
      attributedTo: voter.actorUri,
      to: [actorUrl(poll)],
      inReplyTo: poll.statusUri,
      name: "birds",
      content: "",
      published: "2026-10-20T00:00:00.000Z",
    },
  });

  const storedBy = (voter: Remote) =>
    count("SELECT COUNT(*) AS n FROM remote_statuses WHERE actor_uri = ?", voter.actorUri);

  it("answers 500 and does not store the vote as a status while the poll's status cannot be read", async () => {
    const poll = await createPoll("unread-poll-author@example.com");
    const voter = await remoteActor("unread-poll-voter");
    const activity = datedVote(voter, poll, "https://remote.example/votes/unread-poll");

    // The read of a status also reads its media, which fails without the table.
    await env.DB.exec("ALTER TABLE media_attachments RENAME TO media_attachments_off");
    try {
      expect(await voter.send(activity)).toBe(500);
      expect(await storedBy(voter)).toBe(0);
    } finally {
      await env.DB.exec("ALTER TABLE media_attachments_off RENAME TO media_attachments");
    }

    expect(await voter.send(activity)).toBe(202);
    expect(await storedBy(voter)).toBe(0);
    expect((await pollState(poll)).options.map((option) => option.votes_count)).toEqual([0, 0, 1]);
  });

  it.each([
    ["status", "UPDATE statuses SET visibility = ? WHERE poll_id = ?", "public"],
    [
      "poll",
      "UPDATE polls SET options_json = ? WHERE id = ?",
      JSON.stringify(["cats", "dogs", "birds"].map((title) => ({ title, votesCount: 0 }))),
    ],
  ])(
    "drops a vote with 202 when the row of the %s does not read, as its redelivery would find the same row",
    async (row, sql, readable) => {
      const poll = await createPoll(`unreadable-${row}-author@example.com`);
      const voter = await remoteActor(`unreadable-${row}-voter`);
      const activity = datedVote(voter, poll, `https://remote.example/votes/unreadable-${row}`);

      await env.DB.prepare(sql).bind("unreadable", poll.pollId).run();
      try {
        expect(await voter.send(activity)).toBe(202);
        expect(await storedBy(voter)).toBe(0);
      } finally {
        await env.DB.prepare(sql).bind(readable, poll.pollId).run();
      }

      expect((await pollState(poll)).options.map((option) => option.votes_count)).toEqual([
        0, 0, 0,
      ]);
      expect(
        await count("SELECT COUNT(*) AS n FROM remote_poll_votes WHERE poll_id = ?", poll.pollId),
      ).toBe(0);
    },
  );

  it("distributes a vote that was counted but whose update was never queued, when it is sent again", async () => {
    const poll = await createPoll("counted-vote-author@example.com");
    const voter = await remoteActor("counted-vote-voter");
    expect(await castVote(voter, poll, "cats")).toBe(202);
    // The state a failure between counting the vote and queueing its update leaves.
    await env.DB.prepare("UPDATE polls SET update_queued_at = NULL WHERE id = ?")
      .bind(poll.pollId)
      .run();

    expect(await castVote(voter, poll, "cats")).toBe(202);

    expect(await queuedAt(poll)).toEqual(expect.any(String));
    expect((await pollState(poll)).votes_count).toBe(1);
    await runUpdateJob(poll);
    expect(await updates(poll)).toHaveLength(1);
  });

  it("queues no update for a vote sent again under a new Create id after its update went out", async () => {
    const poll = await createPoll("resent-vote-author@example.com");
    const voter = await remoteActor("resent-vote-voter");
    expect(await castVote(voter, poll, "cats")).toBe(202);
    await runUpdateJob(poll);
    expect(await queuedAt(poll)).toBeNull();

    expect(await castVote(voter, poll, "cats")).toBe(202);

    expect(await queuedAt(poll)).toBeNull();
    expect((await pollState(poll)).votes_count).toBe(1);
  });
});
