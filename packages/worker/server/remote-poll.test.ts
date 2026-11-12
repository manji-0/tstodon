import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { OutboxJob } from "@tstodon/domain";
import { processOutboxJob } from "./outbox-job";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

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

/** A queued vote `Create`: the fields the assertions read, the rest kept for `toMatchObject`. */
const QueuedCreateSchema = z.looseObject({
  object: z.looseObject({ id: z.string().optional(), name: z.string().optional() }),
});

const PollSchema = z.object({
  id: z.string(),
  expires_at: z.string().nullable(),
  expired: z.boolean(),
  multiple: z.boolean(),
  votes_count: z.number().nullable(),
  voters_count: z.number().nullable(),
  voted: z.boolean(),
  own_votes: z.array(z.number()),
  options: z.array(z.object({ title: z.string(), votes_count: z.number().nullable() })),
  emojis: z.array(z.unknown()),
});

const StatusSchema = z.object({
  id: z.string(),
  edited_at: z.string().nullable(),
  content: z.string(),
  poll: PollSchema.nullable(),
});

const choices = (names: ReadonlyArray<string>, counts: ReadonlyArray<number>) =>
  names.map((name, index) => ({
    type: "Note",
    name,
    replies: { type: "Collection", totalItems: counts[index] ?? 0 },
  }));

const question = (
  author: Remote,
  slug: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: `https://remote.example/questions/${slug}`,
  type: "Question",
  attributedTo: author.actorUri,
  content: "<p>Which one?</p>",
  published: "2026-10-20T00:00:00.000Z",
  endTime: "2099-01-01T00:00:00Z",
  to: [PUBLIC],
  oneOf: choices(["cats", "dogs"], [3, 1]),
  votersCount: 4,
  ...extra,
});

const create = async (author: Remote, object: Record<string, unknown>): Promise<string> => {
  expect(
    await author.send({
      id: `${String(object.id)}/create`,
      type: "Create",
      object,
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(object.id)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("remote question was not stored");
  }
  return row.id;
};

const update = (author: Remote, slug: string, object: Record<string, unknown>) =>
  author.send({ id: `https://remote.example/activities/update-${slug}`, type: "Update", object });

const status = async (id: string) =>
  read(StatusSchema, (await json(`/api/v1/statuses/${id}`)).body);

describe("remote polls", () => {
  it("shows a single-choice Question with its options and counts", async () => {
    const author = await remoteActor("poll-single");
    const id = await create(author, question(author, "single"));

    const { poll } = await status(id);
    expect(poll).toMatchObject({
      id: `remote-${id}`,
      expires_at: "2099-01-01T00:00:00.000Z",
      expired: false,
      multiple: false,
      votes_count: 4,
      voters_count: 4,
      voted: false,
      own_votes: [],
      options: [
        { title: "cats", votes_count: 3 },
        { title: "dogs", votes_count: 1 },
      ],
      emojis: [],
    });
  });

  it("treats anyOf as multiple choice and reports votersCount", async () => {
    const author = await remoteActor("poll-multiple");
    const id = await create(
      author,
      question(author, "multiple", {
        oneOf: undefined,
        anyOf: choices(["a", "b", "c"], [5, 2, 0]),
        votersCount: 6,
      }),
    );

    const { poll } = await status(id);
    expect(poll?.multiple).toBe(true);
    expect(poll?.votes_count).toBe(7);
    expect(poll?.voters_count).toBe(6);
    expect(poll?.options.map((option) => option.title)).toEqual(["a", "b", "c"]);
  });

  it("reports a closed poll as expired and an unreported multiple-choice voter total as null", async () => {
    const author = await remoteActor("poll-closed");
    const id = await create(
      author,
      question(author, "closed", {
        endTime: undefined,
        closed: "2026-10-21T00:00:00Z",
        oneOf: undefined,
        anyOf: choices(["x", "y"], [1, 1]),
        votersCount: undefined,
      }),
    );

    const { poll } = await status(id);
    expect(poll?.expired).toBe(true);
    expect(poll?.expires_at).toBe("2026-10-21T00:00:00.000Z");
    expect(poll?.voters_count).toBeNull();
  });

  it("appears on the public timeline", async () => {
    const author = await remoteActor("poll-timeline");
    const id = await create(author, question(author, "timeline"));

    const timeline = await json("/api/v1/timelines/public");
    const entry = read(z.array(StatusSchema), timeline.body).find((item) => item.id === id);
    expect(entry?.poll?.options).toHaveLength(2);
  });

  it("serves the poll read-only at GET /api/v1/polls/:id", async () => {
    const author = await remoteActor("poll-get");
    const id = await create(author, question(author, "get"));

    const fetched = await json(`/api/v1/polls/remote-${id}`);
    expect(fetched.status).toBe(200);
    expect(read(PollSchema, fetched.body).options.map((option) => option.votes_count)).toEqual([
      3, 1,
    ]);
    expect((await json("/api/v1/polls/remote-999999999")).status).toBe(404);
  });

  describe("voting", () => {
    const vote = async (email: string, id: string, choices: ReadonlyArray<number>) =>
      json(`/api/v1/polls/remote-${id}/votes`, {
        method: "POST",
        headers: { ...(await authHeaders(email)), "content-type": "application/json" },
        body: JSON.stringify({ choices }),
      });

    const statusAs = async (email: string, id: string) =>
      read(
        StatusSchema,
        (await json(`/api/v1/statuses/${id}`, { headers: await authHeaders(email) })).body,
      );

    const queuedVotes = async (email: string) => {
      const voter = await signedInAccount(email);
      const rows = await env.DB.prepare(
        `SELECT a.payload_json, d.inbox_url FROM outbound_activities a
         JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NOT NULL
         WHERE a.account_id = ? AND a.kind = 'Create' ORDER BY a.rowid`,
      )
        .bind(voter.id)
        .all<{ payload_json: string; inbox_url: string }>();
      return rows.results.map((row) => ({
        inbox: row.inbox_url,
        activity: QueuedCreateSchema.parse(JSON.parse(row.payload_json)),
      }));
    };

    it("counts the vote, marks it as the viewer's, and federates a Create to the author", async () => {
      const author = await remoteActor("poll-vote");
      const id = await create(author, question(author, "vote"));
      const email = "remote-poll-voter@example.com";

      const voted = await vote(email, id, [1]);
      expect(voted.status).toBe(200);
      const poll = read(PollSchema, voted.body);
      expect(poll).toMatchObject({
        id: `remote-${id}`,
        voted: true,
        own_votes: [1],
        votes_count: 5,
        voters_count: 5,
        options: [
          { title: "cats", votes_count: 3 },
          { title: "dogs", votes_count: 2 },
        ],
      });

      const viewer = await signedInAccount(email);
      const queued = await queuedVotes(email);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.inbox).toBe(`${author.actorUri}/inbox`);
      expect(queued[0]?.activity).toMatchObject({
        type: "Create",
        actor: `https://example.com/users/${viewer.username}`,
        to: [author.actorUri],
        object: {
          type: "Note",
          name: "dogs",
          inReplyTo: "https://remote.example/questions/vote",
          attributedTo: `https://example.com/users/${viewer.username}`,
          to: [author.actorUri],
        },
      });

      const fetched = read(
        PollSchema,
        (await json(`/api/v1/polls/remote-${id}`, { headers: await authHeaders(email) })).body,
      );
      expect(fetched).toMatchObject({ voted: true, own_votes: [1], votes_count: 5 });
      const asViewer = await statusAs(email, id);
      expect(asViewer.poll).toMatchObject({ voted: true, own_votes: [1] });
      const anonymous = await status(id);
      expect(anonymous.poll).toMatchObject({ voted: false, own_votes: [], votes_count: 5 });
    });

    it("federates one Create per choice of a multiple-choice poll", async () => {
      const author = await remoteActor("poll-vote-multi");
      const id = await create(
        author,
        question(author, "vote-multi", {
          oneOf: undefined,
          anyOf: choices(["a", "b", "c"], [2, 0, 1]),
          votersCount: 3,
        }),
      );
      const email = "remote-poll-multi@example.com";

      const voted = read(PollSchema, (await vote(email, id, [0, 2])).body);
      expect(voted).toMatchObject({
        voted: true,
        own_votes: [0, 2],
        votes_count: 5,
        voters_count: 4,
      });
      expect(voted.options.map((option) => option.votes_count)).toEqual([3, 0, 2]);

      const queued = await queuedVotes(email);
      expect(queued.map((entry) => entry.activity.object.name)).toEqual(["a", "c"]);
      expect(new Set(queued.map((entry) => entry.activity.object.id)).size).toBe(2);
      expect(queued.every((entry) => entry.inbox === `${author.actorUri}/inbox`)).toBe(true);
    });

    it("keeps the tally and the local vote on top of it when the author's new counts cannot be settled, and settles on redelivery", async () => {
      const author = await remoteActor("poll-vote-settle");
      const id = await create(author, question(author, "vote-settle"));
      const email = "remote-poll-settle@example.com";
      expect((await vote(email, id, [1])).status).toBe(200);
      const counted = question(author, "vote-settle", {
        oneOf: choices(["cats", "dogs"], [3, 2]),
        votersCount: 5,
      });
      const counts = async () =>
        (await status(id)).poll?.options.map((option) => option.votes_count);

      await env.DB.prepare(
        `CREATE TRIGGER remote_poll_settle_refused BEFORE UPDATE ON remote_poll_own_votes
         WHEN OLD.status_id = '${id}' BEGIN SELECT RAISE(ABORT, 'write refused'); END`,
      ).run();
      try {
        expect(await update(author, "vote-settle", counted)).toBe(500);
        expect(await counts()).toEqual([3, 2]);
      } finally {
        await env.DB.prepare("DROP TRIGGER remote_poll_settle_refused").run();
      }

      expect(await update(author, "vote-settle", counted)).toBe(202);
      expect(await counts()).toEqual([3, 2]);
      expect((await statusAs(email, id)).poll).toMatchObject({ own_votes: [1], voters_count: 5 });
    });

    it("settles the local vote when the author's new counts replace a row that does not read", async () => {
      const author = await remoteActor("poll-vote-heal");
      const id = await create(author, question(author, "vote-heal"));
      const email = "remote-poll-heal@example.com";
      expect((await vote(email, id, [1])).status).toBe(200);
      await env.DB.prepare("UPDATE remote_statuses SET visibility = 'unreadable' WHERE id = ?")
        .bind(id)
        .run();

      expect(
        await update(
          author,
          "vote-heal",
          question(author, "vote-heal", {
            oneOf: choices(["cats", "dogs"], [3, 2]),
            votersCount: 5,
          }),
        ),
      ).toBe(202);

      const { poll } = await statusAs(email, id);
      expect(poll?.options.map((option) => option.votes_count)).toEqual([3, 2]);
      expect(poll).toMatchObject({ own_votes: [1], voters_count: 5 });
    });

    it("refuses a second vote", async () => {
      const author = await remoteActor("poll-vote-twice");
      const id = await create(author, question(author, "vote-twice"));
      const email = "remote-poll-twice@example.com";

      expect((await vote(email, id, [0])).status).toBe(200);
      expect((await vote(email, id, [1])).status).toBe(422);
      expect(await queuedVotes(email)).toHaveLength(1);
    });

    it("refuses an expired poll, an out-of-range choice, and too many choices", async () => {
      const author = await remoteActor("poll-vote-refused");
      const email = "remote-poll-refused@example.com";
      const expired = await create(
        author,
        question(author, "vote-expired", { endTime: "2020-01-01T00:00:00Z" }),
      );
      const open = await create(author, question(author, "vote-open"));

      expect((await vote(email, expired, [0])).status).toBe(422);
      expect((await vote(email, open, [2])).status).toBe(422);
      expect((await vote(email, open, [-1])).status).toBe(422);
      expect((await vote(email, open, [0, 1])).status).toBe(422);
      expect((await vote(email, open, [])).status).toBe(422);
      expect(await queuedVotes(email)).toHaveLength(0);
      expect((await statusAs(email, open)).poll).toMatchObject({ voted: false, votes_count: 4 });
    });

    it("answers 404 for a poll that is not there", async () => {
      expect((await vote("remote-poll-missing@example.com", "999999999", [0])).status).toBe(404);
    });

    it("refuses a poll on a suspended domain", async () => {
      const author = await remoteActor("poll-vote-suspended", "suspended-poll.example");
      const id = await create(
        author,
        question(author, "vote-suspended", {
          id: "https://suspended-poll.example/questions/vote-suspended",
        }),
      );
      const admin = { ...(await authHeaders("remote-poll-admin@example.com", { admin: true })) };
      expect(
        (
          await json("/api/v1/admin/domain_blocks", {
            method: "POST",
            headers: { ...admin, "content-type": "application/json" },
            body: JSON.stringify({ domain: "suspended-poll.example", severity: "suspend" }),
          })
        ).status,
      ).toBe(200);

      expect((await vote("remote-poll-suspended@example.com", id, [0])).status).toBe(422);
    });

    it("refuses a poll on a domain the voter blocked", async () => {
      const author = await remoteActor("poll-vote-blocked", "blocked-poll.example");
      const id = await create(
        author,
        question(author, "vote-blocked", {
          id: "https://blocked-poll.example/questions/vote-blocked",
        }),
      );
      const email = "remote-poll-blocker@example.com";
      expect(
        (
          await json("/api/v1/domain_blocks", {
            method: "POST",
            headers: { ...(await authHeaders(email)), "content-type": "application/json" },
            body: JSON.stringify({ domain: "blocked-poll.example" }),
          })
        ).status,
      ).toBe(200);

      expect((await vote(email, id, [0])).status).toBe(422);
    });

    it("keeps the vote when the author's next Update replaces the counts", async () => {
      const author = await remoteActor("poll-vote-update");
      const id = await create(author, question(author, "vote-update"));
      const email = "remote-poll-update@example.com";
      expect((await vote(email, id, [0])).status).toBe(200);

      expect(
        await update(
          author,
          "vote-update",
          question(author, "vote-update", {
            oneOf: choices(["cats", "dogs"], [4, 1]),
            votersCount: 5,
          }),
        ),
      ).toBe(202);

      const { poll } = await statusAs(email, id);
      expect(poll).toMatchObject({ voted: true, own_votes: [0], votes_count: 5, voters_count: 5 });
      expect(poll?.options.map((option) => option.votes_count)).toEqual([4, 1]);
    });
  });

  it("renders the custom emoji its option titles use", async () => {
    const author = await remoteActor("poll-emoji");
    const id = await create(
      author,
      question(author, "emoji", {
        oneOf: choices([":cat: cats", "dogs"], [1, 1]),
        tag: [
          { type: "Emoji", name: ":cat:", icon: { url: "https://remote.example/cat.png" } },
          { type: "Emoji", name: ":unused:", icon: { url: "https://remote.example/unused.png" } },
        ],
      }),
    );
    const { poll } = await status(id);
    expect(poll?.emojis).toEqual([
      {
        shortcode: "cat",
        url: "https://remote.example/cat.png",
        static_url: "https://remote.example/cat.png",
        visible_in_picker: false,
      },
    ]);
    const direct = read(PollSchema, (await json(`/api/v1/polls/remote-${id}`)).body);
    expect(direct.emojis).toHaveLength(1);
  });

  describe("expiry notifications", () => {
    const vote = (email: string, id: string) =>
      authHeaders(email).then((headers) =>
        json(`/api/v1/polls/remote-${id}/votes`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ choices: [0] }),
        }),
      );

    const runExpiryJob = async () => {
      const job = OutboxJob.parse({ kind: "ProcessExpiredPolls" });
      if (job.isErr()) {
        throw new Error("expired polls job rejected");
      }
      await processOutboxJob(env, job.value);
    };

    const pollNotifications = async (email: string) =>
      read(
        z.array(z.object({ type: z.string(), status: z.object({ id: z.string() }) })),
        (await json("/api/v1/notifications?types[]=poll", { headers: await authHeaders(email) }))
          .body,
      );

    const endPoll = (id: string) =>
      env.DB.prepare(
        "UPDATE remote_statuses SET poll_json = json_set(poll_json, '$.ends.at', ?) WHERE id = ?",
      )
        .bind("2020-01-01T00:00:00.000Z", id)
        .run();

    it("tells a local voter once, only after the poll has ended", async () => {
      const author = await remoteActor("poll-expiry");
      const id = await create(author, question(author, "expiry"));
      const voter = "remote-poll-expiry-voter@example.com";
      const bystander = "remote-poll-expiry-bystander@example.com";
      await authHeaders(bystander);
      expect((await vote(voter, id)).status).toBe(200);

      await runExpiryJob();
      expect(await pollNotifications(voter)).toEqual([]);

      await endPoll(id);
      await runExpiryJob();
      await runExpiryJob();
      expect(await pollNotifications(voter)).toMatchObject([{ type: "poll", status: { id } }]);
      expect(await pollNotifications(bystander)).toEqual([]);
    });

    it("does not announce a poll nobody voted on", async () => {
      const author = await remoteActor("poll-expiry-unvoted");
      await create(author, question(author, "expiry-unvoted", { endTime: "2020-01-01T00:00:00Z" }));
      await runExpiryJob();
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE kind = 'poll' AND from_account_id = ?",
      )
        .bind(RemoteAccountId.encode(author.actorUri))
        .first<{ n: number }>();
      expect(count?.n).toBe(0);
    });
  });

  it("refreshes counts from an Update without marking the status edited", async () => {
    const author = await remoteActor("poll-update");
    const id = await create(author, question(author, "update"));

    expect(
      await update(
        author,
        "counts",
        question(author, "update", {
          oneOf: choices(["cats", "dogs"], [10, 7]),
          votersCount: 17,
        }),
      ),
    ).toBe(202);

    const refreshed = await status(id);
    expect(refreshed.poll?.options.map((option) => option.votes_count)).toEqual([10, 7]);
    expect(refreshed.poll?.voters_count).toBe(17);
    expect(refreshed.edited_at).toBeNull();
  });

  it("keeps applying count refreshes after the poll was edited", async () => {
    const author = await remoteActor("poll-edit-then-count");
    const id = await create(author, question(author, "edit-count"));
    await update(
      author,
      "edit-count-1",
      question(author, "edit-count", {
        content: "<p>Which one, really?</p>",
        updated: "2026-10-22T00:00:00Z",
      }),
    );
    await update(
      author,
      "edit-count-2",
      question(author, "edit-count", {
        content: "<p>Which one, really?</p>",
        oneOf: choices(["cats", "dogs"], [4, 4]),
      }),
    );

    const current = await status(id);
    expect(current.edited_at).toBe("2026-10-22T00:00:00.000Z");
    expect(current.poll?.options.map((option) => option.votes_count)).toEqual([4, 4]);
  });

  it("marks the status edited when the options change", async () => {
    const author = await remoteActor("poll-options");
    const id = await create(author, question(author, "options"));

    await update(
      author,
      "options",
      question(author, "options", {
        oneOf: choices(["cats", "dogs", "birds"], [0, 0, 0]),
        updated: "2026-10-22T00:00:00Z",
      }),
    );

    const edited = await status(id);
    expect(edited.poll?.options).toHaveLength(3);
    expect(edited.edited_at).toBe("2026-10-22T00:00:00.000Z");
  });

  it("ignores an Update to a poll from another actor", async () => {
    const author = await remoteActor("poll-owner");
    const impostor = await remoteActor("poll-impostor", "elsewhere.example");
    const id = await create(author, question(author, "hijack"));

    expect(
      await update(
        impostor,
        "hijack",
        question(author, "hijack", { oneOf: choices(["cats", "dogs"], [99, 99]) }),
      ),
    ).toBe(202);

    expect((await status(id)).poll?.options.map((option) => option.votes_count)).toEqual([3, 1]);
  });
});
