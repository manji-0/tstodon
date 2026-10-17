import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "./schemas";

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

const StatusIdSchema = z.object({ id: z.string().min(1) });

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const postStatus = async (email: string, payload: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return read(StatusIdSchema, response.body).id;
};

const ids = async (path: string): Promise<string[]> => {
  const response = await json(path);
  expect(response.status).toBe(200);
  return read(z.array(StatusIdSchema), response.body).map((status) => status.id);
};

describe("account status filters", () => {
  it("filters replies, reblogs, media, tags, and max_id", async () => {
    const email = "acct-filter@example.com";
    const accountId = await accountIdFor(email);
    const plainId = await postStatus(email, { status: "plain note" });
    const replyId = await postStatus(email, {
      status: "a reply",
      in_reply_to_id: plainId,
    });
    const taggedId = await postStatus(email, { status: "note with #filterwave" });

    const media = await json("/api/v2/media", {
      method: "POST",
      headers: await auth(email),
      body: (() => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array([1, 2, 3])], "a.png", { type: "image/png" }));
        return form;
      })(),
    });
    expect(media.status).toBe(200);
    const mediaId = read(StatusIdSchema, media.body).id;
    const mediaStatusId = await postStatus(email, {
      status: "note with media",
      media_ids: [mediaId],
    });

    const reblog = await json(`/api/v1/statuses/${plainId}/reblog`, {
      method: "POST",
      headers: await auth(email),
    });
    expect(reblog.status).toBe(200);
    const reblogId = read(StatusIdSchema, reblog.body).id;

    const base = `/api/v1/accounts/${accountId}/statuses`;
    const all = await ids(base);
    expect(all).toEqual(
      expect.arrayContaining([plainId, replyId, taggedId, mediaStatusId, reblogId]),
    );
    expect(reblogId).not.toBe(plainId);

    expect(await ids(`${base}?exclude_replies=true`)).not.toContain(replyId);
    expect(await ids(`${base}?exclude_reblogs=true`)).not.toContain(reblogId);

    const onlyMedia = await ids(`${base}?only_media=true`);
    expect(onlyMedia).toEqual([mediaStatusId]);

    expect(await ids(`${base}?tagged=filterwave`)).toEqual([taggedId]);

    const newest = [...all].toSorted((left, right) => right.localeCompare(left))[0];
    expect(newest).toBeDefined();
    const paged = await ids(`${base}?max_id=${newest}`);
    expect(paged).not.toContain(newest);
    expect(paged.length).toBe(all.length - 1);
  });
});
