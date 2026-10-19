import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

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

const PollSchema = z.object({
  id: z.string().min(1),
  expired: z.boolean(),
  multiple: z.boolean(),
  votes_count: z.number().nullable(),
  voters_count: z.number().nullable(),
  voted: z.boolean(),
  options: z.array(z.object({ title: z.string(), votes_count: z.number().nullable() })),
});

const createPoll = async (
  email: string,
  poll: Record<string, unknown>,
): Promise<{ statusId: string; poll: z.infer<typeof PollSchema> }> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600, ...poll },
    }),
  });
  expect(response.status).toBe(200);
  const document = read(z.object({ id: z.string().min(1), poll: PollSchema }), response.body);
  return { statusId: document.id, poll: document.poll };
};

describe("poll hide_totals", () => {
  it("withholds counts until the poll ends", async () => {
    const author = "hide-author@example.com";
    const voter = "hide-voter@example.com";
    const { poll } = await createPoll(author, { hide_totals: true });
    expect(poll.votes_count).toBeNull();
    expect(poll.options.map((option) => option.votes_count)).toEqual([null, null]);

    const voted = await json(`/api/v1/polls/${poll.id}/votes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(voter)) },
      body: JSON.stringify({ choices: [0] }),
    });
    expect(voted.status).toBe(200);
    // Mastodon answers a vote with the Poll entity itself.
    const afterVote = read(PollSchema, voted.body);
    expect(afterVote.votes_count).toBeNull();
    expect(afterVote.options.map((option) => option.votes_count)).toEqual([null, null]);
    expect(afterVote.voted).toBe(true);

    // Other readers see the same hidden totals.
    const fetched = await json(`/api/v1/polls/${poll.id}`, {
      headers: await auth("hide-observer@example.com"),
    });
    expect(read(PollSchema, fetched.body).votes_count).toBeNull();
  });

  it("reveals counts when the poll does not hide them", async () => {
    const author = "show-author@example.com";
    const voter = "show-voter@example.com";
    const { poll } = await createPoll(author, {});
    expect(poll.votes_count).toBe(0);

    await json(`/api/v1/polls/${poll.id}/votes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth(voter)) },
      body: JSON.stringify({ choices: [1] }),
    });
    const fetched = await json(`/api/v1/polls/${poll.id}`, {
      headers: await auth(author),
    });
    const visible = read(PollSchema, fetched.body);
    expect(visible.votes_count).toBe(1);
    expect(visible.options[1]?.votes_count).toBe(1);
    // Single-choice polls report no voter count.
    expect(visible.voters_count).toBeNull();
  });
});
