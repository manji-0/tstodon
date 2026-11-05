import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

/** A request the create or edit flow turns away, with the exact answer Mastodon clients see. */
type RefusalCase = Readonly<{
  name: string;
  body: Readonly<Record<string, unknown>>;
  status: 400 | 404 | 422;
  error: Readonly<{ error: string; kind: string }>;
}>;

const createRefusals = [
  {
    name: "an unknown visibility",
    body: { status: "hello", visibility: "everyone" },
    status: 400,
    error: { error: "Invalid visibility", kind: "Unknown" },
  },
  {
    name: "a poll with one option",
    body: { status: "poll", poll: { options: ["only"], expires_in: 3600 } },
    status: 422,
    error: { error: "poll options must be between 2 and 4", kind: "PollOptionsOutOfRange" },
  },
  {
    name: "a poll option over the length limit",
    body: { status: "poll", poll: { options: ["a", "b".repeat(51)], expires_in: 3600 } },
    status: 422,
    error: { error: "poll option is too long", kind: "PollOptionTooLong" },
  },
  {
    name: "a quote of a status that does not exist",
    body: { status: "quote", quoted_status_id: "missing-status" },
    status: 404,
    error: { error: "Record not found", kind: "NotFound" },
  },
  {
    name: "an unknown quote approval policy",
    body: { status: "hello", quote_approval_policy: "everyone" },
    status: 422,
    error: { error: "Invalid quote_approval_policy", kind: "ValidationError" },
  },
  {
    name: "a reply to a status that does not exist",
    body: { status: "reply", in_reply_to_id: "missing-status" },
    status: 404,
    error: { error: "Record not found", kind: "NotFound" },
  },
  {
    name: "a schedule in the past",
    body: { status: "later", scheduled_at: "2000-01-01T00:00:00Z" },
    status: 422,
    error: {
      error: "scheduled_at must be at least 5 minutes in the future",
      kind: "InvalidScheduledAt",
    },
  },
] as const satisfies ReadonlyArray<RefusalCase>;

const editRefusals = [
  {
    name: "an unknown visibility",
    body: { status: "edited", visibility: "everyone" },
    status: 400,
    error: { error: "Invalid visibility", kind: "Unknown" },
  },
  {
    name: "a poll on a note posted without one",
    body: { status: "edited", poll: { options: ["a", "b"], expires_in: 3600 } },
    status: 422,
    error: { error: "cannot edit a poll", kind: "PollEditUnsupported" },
  },
  {
    name: "an unknown quote approval policy",
    body: { status: "edited", quote_approval_policy: "everyone" },
    status: 422,
    error: { error: "Invalid quote_approval_policy", kind: "ValidationError" },
  },
] as const satisfies ReadonlyArray<RefusalCase>;

const credentialRefusals = [
  {
    name: "a malformed default language",
    body: { source: { language: "not a language" } },
    status: 422,
    error: { error: "Invalid source[language]", kind: "ValidationError" },
  },
  {
    name: "an unknown default privacy",
    body: { source: { privacy: "everyone" } },
    status: 422,
    error: { error: "Invalid source[privacy]", kind: "ValidationError" },
  },
  {
    name: "an unknown default quote policy",
    body: { source: { quote_policy: "everyone" } },
    status: 422,
    error: { error: "Invalid source[quote_policy]", kind: "ValidationError" },
  },
  {
    name: "an avatar that is not a file",
    body: { avatar: "not-a-file" },
    status: 422,
    error: { error: "avatar must be sent as a file", kind: "ValidationError" },
  },
] as const satisfies ReadonlyArray<RefusalCase>;

const send = async (
  path: string,
  method: "POST" | "PUT" | "PATCH",
  email: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
};

describe("status create refusals", () => {
  it.each(createRefusals)("answers $name with its Mastodon error", async (refusal) => {
    const answer = await send(
      "/api/v1/statuses",
      "POST",
      "refusal-create@example.com",
      refusal.body,
    );
    expect(answer).toEqual({ status: refusal.status, body: refusal.error });
  });
});

describe("status edit refusals", () => {
  it.each(editRefusals)("answers $name with its Mastodon error", async (refusal) => {
    const email = "refusal-edit@example.com";
    const created = await send("/api/v1/statuses", "POST", email, { status: "original" });
    const id = schemaResult(z.object({ id: z.string().min(1) }))(created.body);
    if (id.isErr()) {
      throw new Error("create returned no status id");
    }
    const answer = await send(`/api/v1/statuses/${id.value.id}`, "PUT", email, refusal.body);
    expect(answer).toEqual({ status: refusal.status, body: refusal.error });

    // Mastodon validates the whole edit before it stores any of it.
    const headers = await authHeaders(email);
    const source = await SELF.fetch(`https://example.com/api/v1/statuses/${id.value.id}/source`, {
      headers,
    });
    expect(await source.json()).toMatchObject({ text: "original" });
    const history = await SELF.fetch(`https://example.com/api/v1/statuses/${id.value.id}/history`, {
      headers,
    });
    expect(await history.json()).toHaveLength(1);
  });
});

describe("update_credentials refusals", () => {
  it.each(credentialRefusals)("answers $name with its Mastodon error", async (refusal) => {
    const answer = await send(
      "/api/v1/accounts/update_credentials",
      "PATCH",
      "refusal-credentials@example.com",
      refusal.body,
    );
    expect(answer).toEqual({ status: refusal.status, body: refusal.error });
  });
});
