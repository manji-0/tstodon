import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
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

const updates = async (poll: LocalPoll): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const rows = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid",
  )
    .bind(poll.authorId)
    .all<{ payload_json: string }>();
  return rows.results.map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
};

describe("remote votes on a local poll", () => {
  it("serves a poll note as a Question with options and counts", async () => {
    const poll = await createPoll("question-author@example.com", { multiple: true });
    const response = await SELF.fetch(`https://example.com${new URL(poll.statusUri).pathname}`, {
      headers: { accept: "application/activity+json" },
    });
    expect(response.status).toBe(200);
    const note = (await response.json()) as Record<string, unknown>;
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
    const note = (await (
      await SELF.fetch(`https://example.com${new URL(poll.statusUri).pathname}`)
    ).json()) as Record<string, unknown>;
    expect(note.type).toBe("Question");
    expect(note.anyOf).toBeUndefined();
    expect(Array.isArray(note.oneOf)).toBe(true);

    const created = await env.DB.prepare(
      "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Create'",
    )
      .bind(poll.authorId)
      .first<{ payload_json: string }>();
    const activity = JSON.parse(created?.payload_json ?? "{}") as { object?: { type?: string } };
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

  it("federates an Update of the Question after a vote", async () => {
    const poll = await createPoll("update-author@example.com");
    const voter = await remoteActor("update-voter");
    expect(await updates(poll)).toHaveLength(0);

    expect(await castVote(voter, poll, "birds")).toBe(202);

    const [update] = await updates(poll);
    expect(update).toMatchObject({
      type: "Update",
      actor: actorUrl(poll),
      object: {
        id: poll.statusUri,
        type: "Question",
        votersCount: 1,
        oneOf: [
          { name: "cats", replies: { totalItems: 0 } },
          { name: "dogs", replies: { totalItems: 0 } },
          { name: "birds", replies: { totalItems: 1 } },
        ],
      },
    });
  });
});
