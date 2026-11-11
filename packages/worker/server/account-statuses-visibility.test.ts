import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

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

const IdSchema = z.object({ id: z.string().min(1) });

const post = async (email: string, path: string, payload: Record<string, unknown> = {}) => {
  const response = await json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(payload),
  });
  expect(response.status, path).toBe(200);
  return read(IdSchema, response.body).id;
};

const ids = async (path: string, email?: string): Promise<string[]> => {
  const response = await json(path, email ? { headers: await authHeaders(email) } : undefined);
  expect(response.status, path).toBe(200);
  return read(z.array(IdSchema), response.body).map((status) => status.id);
};

/** Mastodon's `AccountStatusesFilter` for a local account's statuses. */
describe("an account's statuses as each viewer sees them", () => {
  it("lists only the statuses the viewer may see", async () => {
    const author = "asv-author@example.com";
    const follower = "asv-follower@example.com";
    const mentioned = "asv-mentioned@example.com";
    const stranger = "asv-stranger@example.com";
    const blocked = "asv-blocked@example.com";
    const authorId = (await signedInAccount(author)).id;
    const mentionedName = (await signedInAccount(mentioned)).username;
    const blockedId = (await signedInAccount(blocked)).id;
    await signedInAccount(stranger);
    await post(follower, `/api/v1/accounts/${authorId}/follow`);

    const publicId = await post(author, "/api/v1/statuses", {
      status: "for everyone",
      visibility: "public",
    });
    const unlistedId = await post(author, "/api/v1/statuses", {
      status: "quietly public",
      visibility: "unlisted",
    });
    const privateId = await post(author, "/api/v1/statuses", {
      status: "followers only",
      visibility: "private",
    });
    const privateMentionId = await post(author, "/api/v1/statuses", {
      status: `followers and @${mentionedName}`,
      visibility: "private",
    });
    const directId = await post(author, "/api/v1/statuses", {
      status: `only @${mentionedName}`,
      visibility: "direct",
    });
    await post(author, `/api/v1/accounts/${blockedId}/block`);

    const path = `/api/v1/accounts/${authorId}/statuses`;
    const open = [unlistedId, publicId];
    expect(await ids(path)).toEqual(open);
    expect(await ids(path, stranger)).toEqual(open);
    expect(await ids(path, follower)).toEqual([privateMentionId, privateId, ...open]);
    expect(await ids(path, mentioned)).toEqual([directId, privateMentionId, ...open]);
    expect(await ids(`${path}?exclude_direct=true`, mentioned)).toEqual([
      privateMentionId,
      ...open,
    ]);
    expect(await ids(path, blocked)).toEqual([]);
    expect(await ids(path, author)).toEqual([directId, privateMentionId, privateId, ...open]);
  });

  it("fills a page past statuses the viewer may not see", async () => {
    const author = "asv-paged-author@example.com";
    const authorId = (await signedInAccount(author)).id;
    const olderId = await post(author, "/api/v1/statuses", { status: "older" });
    const newerId = await post(author, "/api/v1/statuses", { status: "newer" });
    for (const visibility of ["private", "direct", "private"]) {
      await post(author, "/api/v1/statuses", { status: "hidden", visibility });
    }

    expect(await ids(`/api/v1/accounts/${authorId}/statuses?limit=2`)).toEqual([newerId, olderId]);
  });

  it("lists a pinned followers-only status to followers only", async () => {
    const author = "asv-pin-author@example.com";
    const follower = "asv-pin-follower@example.com";
    const authorId = (await signedInAccount(author)).id;
    await post(follower, `/api/v1/accounts/${authorId}/follow`);
    const privateId = await post(author, "/api/v1/statuses", {
      status: "pinned for followers",
      visibility: "private",
    });
    await post(author, `/api/v1/statuses/${privateId}/pin`);

    const path = `/api/v1/accounts/${authorId}/statuses?pinned=true`;
    expect(await ids(path)).toEqual([]);
    expect(await ids(path, follower)).toEqual([privateId]);
    expect(await ids(path, author)).toEqual([privateId]);
  });
});
