import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
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

const StatusSchema = z.object({
  id: z.string().min(1),
  visibility: z.string().min(1),
  reblogs_count: z.number(),
  reblog: z.object({ id: z.string().min(1), visibility: z.string().min(1) }).nullable(),
});

const postStatus = async (
  email: string,
  body: Record<string, unknown>,
): Promise<z.infer<typeof StatusSchema>> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return read(StatusSchema, response.body);
};

const boost = async (
  email: string,
  statusId: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json(`/api/v1/statuses/${statusId}/reblog`, {
    method: "POST",
    headers: body
      ? { "content-type": "application/json", ...(await auth(email)) }
      : await auth(email),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("reblog semantics", () => {
  it("stores the requested visibility on the boost, not on the original", async () => {
    const author = "reblog-vis-author@example.com";
    const booster = "reblog-vis-booster@example.com";
    const status = await postStatus(author, { status: "boost me quietly" });

    const boosted = await boost(booster, status.id, { visibility: "unlisted" });
    expect(boosted.status).toBe(200);
    const document = read(StatusSchema, boosted.body);
    expect(document.visibility).toBe("unlisted");
    // The shared status keeps its own visibility inside `reblog`.
    expect(document.reblog?.id).toBe(status.id);
    expect(document.reblog?.visibility).toBe("public");

    // Public and unlisted are both rebloggable; a bare boost defaults to
    // public.
    const plain = await postStatus(author, { status: "boost me loudly" });
    const defaulted = await boost(booster, plain.id);
    expect(read(StatusSchema, defaulted.body).visibility).toBe("public");
    expect(read(StatusSchema, defaulted.body).reblog?.id).toBe(plain.id);
  });

  it("never makes a boost more visible than the status it shares", async () => {
    const author = "reblog-private@example.com";
    const own = await postStatus(author, { status: "followers only", visibility: "private" });
    const boosted = await boost(author, own.id, { visibility: "public" });
    expect(boosted.status).toBe(200);
    // The boost inherits `private` instead of the requested `public`.
    const document = read(StatusSchema, boosted.body);
    expect(document.visibility).toBe("private");
    expect(document.reblog?.visibility).toBe("private");
  });

  it("refuses boosts Mastodon refuses", async () => {
    const author = "reblog-refuse-author@example.com";
    const stranger = "reblog-refuse-stranger@example.com";

    // Someone else's followers-only status is not rebloggable.
    const privateStatus = await postStatus(author, {
      status: "only for followers",
      visibility: "private",
    });
    const foreign = await boost(stranger, privateStatus.id);
    expect(foreign.status).toBe(404);

    // A direct status is not rebloggable, not even by its author.
    const direct = await postStatus(author, { status: "a whisper", visibility: "direct" });
    expect((await boost(author, direct.id)).status).toBe(404);

    // A boost may not be direct.
    const publicStatus = await postStatus(author, { status: "everyone can see this" });
    const invalid = await boost(stranger, publicStatus.id, { visibility: "direct" });
    expect(invalid.status).toBe(400);
    expect(read(z.object({ error: z.string() }), invalid.body).error).toBe("Invalid visibility");
  });

  it("answers the existing boost instead of stacking another", async () => {
    const author = "reblog-once-author@example.com";
    const booster = "reblog-once-booster@example.com";
    const status = await postStatus(author, { status: "boosted once" });

    const first = read(StatusSchema, (await boost(booster, status.id)).body);
    const second = read(StatusSchema, (await boost(booster, status.id)).body);
    expect(second.id).toBe(first.id);

    const fetched = await json(`/api/v1/statuses/${status.id}`);
    expect(read(StatusSchema, fetched.body).reblogs_count).toBe(1);
  });

  it("shares the original when a boost is boosted", async () => {
    const author = "reblog-chain-author@example.com";
    const firstBooster = "reblog-chain-first@example.com";
    const secondBooster = "reblog-chain-second@example.com";
    const status = await postStatus(author, { status: "boost the boost" });

    const first = read(StatusSchema, (await boost(firstBooster, status.id)).body);
    const second = read(StatusSchema, (await boost(secondBooster, first.id)).body);

    expect(second.id).not.toBe(first.id);
    // The second boost points at the original, not at the first boost.
    expect(second.reblog?.id).toBe(status.id);

    const fetched = await json(`/api/v1/statuses/${status.id}`);
    expect(read(StatusSchema, fetched.body).reblogs_count).toBe(2);
  });
});
