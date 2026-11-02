import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";

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
      expires_at: "2099-01-01T00:00:00Z",
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
    expect(poll?.expires_at).toBe("2026-10-21T00:00:00Z");
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

  it("answers a vote on a remote poll with a 4xx", async () => {
    const author = await remoteActor("poll-vote");
    const id = await create(author, question(author, "vote"));
    const headers = {
      ...(await authHeaders("remote-poll-voter@example.com")),
      "content-type": "application/json",
    };

    const voted = await json(`/api/v1/polls/remote-${id}/votes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ choices: [0] }),
    });
    expect(voted.status).toBe(422);
    expect((await status(id)).poll?.votes_count).toBe(4);
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
    expect(current.edited_at).toBe("2026-10-22T00:00:00Z");
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
    expect(edited.edited_at).toBe("2026-10-22T00:00:00Z");
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
