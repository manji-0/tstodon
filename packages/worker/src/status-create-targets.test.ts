import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { openStream } from "../test/stream-fixture";
import { processOutboxJob } from "./outbox-job";
import { insertScheduledStatus } from "./scheduled-status-store";

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

const send = async (email: string, method: string, path: string, body: unknown) =>
  json(path, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });

const upload = async (email: string): Promise<string> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([9, 9, 9])], "photo.png", { type: "image/png" }));
  const response = await json("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const Posted = z.object({
  id: z.string(),
  media_attachments: z.array(z.object({ id: z.string(), url: z.string() })),
});

const postStatus = async (email: string, body: Record<string, unknown>) => {
  const response = await send(email, "POST", "/api/v1/statuses", body);
  expect(response.status).toBe(200);
  return read(Posted, response.body);
};

/** Mastodon's `media_attachments.validations.not_found`. */
const mediaNotFound = (ids: ReadonlyArray<string>) => ({
  error: `Media ${ids.join(", ")} not found or already attached to another post`,
});

const countRows = async (sql: string, ...binds: string[]): Promise<number> => {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? -1;
};

const statusCount = (accountId: string) =>
  countRows("SELECT COUNT(*) AS n FROM statuses WHERE account_id = ?", accountId);

const scheduledCount = (accountId: string) =>
  countRows("SELECT COUNT(*) AS n FROM scheduled_statuses WHERE account_id = ?", accountId);

const inSixMinutes = (): string => new Date(Date.now() + 6 * 60 * 1000).toISOString();

const suspend = async (accountId: string) => {
  const response = await json(`/api/v1/admin/accounts/${accountId}/suspend`, {
    method: "POST",
    headers: await authHeaders("create-targets-admin@example.com", { admin: true }),
  });
  expect(response.status).toBe(200);
};

/** A private post by `owner` with one picture: the picture's id and its unguessable URL. */
const privatePicture = async (owner: string) => {
  const mediaId = await upload(owner);
  const kept = await postStatus(owner, {
    status: "only for followers",
    visibility: "private",
    media_ids: [mediaId],
  });
  const url = kept.media_attachments[0]?.url ?? "";
  expect(url).not.toBe("");
  return { mediaId, url, statusId: kept.id };
};

describe("media_ids naming media the author may not attach", () => {
  it("refuses a post with another account's media, and stores and streams nothing", async () => {
    const owner = "create-targets-owner@example.com";
    const borrower = "create-targets-borrower@example.com";
    const picture = await privatePicture(owner);
    const borrowerId = (await signedInAccount(borrower)).id;
    const stream = await openStream({ email: borrower, query: "?stream=user" });

    const refused = await send(borrower, "POST", "/api/v1/statuses", {
      status: "borrowing a picture",
      media_ids: [picture.mediaId],
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject(mediaNotFound([picture.mediaId]));
    expect(JSON.stringify(refused.body)).not.toContain(picture.url);
    expect(await statusCount(borrowerId)).toBe(0);
    expect(await stream.heardNothing()).toBe(true);
    stream.close();
  });

  it("refuses the author's own media that another status already holds", async () => {
    const owner = "create-targets-reuse@example.com";
    const picture = await privatePicture(owner);
    const fresh = await upload(owner);

    const refused = await send(owner, "POST", "/api/v1/statuses", {
      status: "again",
      media_ids: [fresh, picture.mediaId],
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject(mediaNotFound([picture.mediaId]));
    const reused = await postStatus(owner, { status: "fresh one", media_ids: [fresh] });
    expect(reused.media_attachments.map((media) => media.id)).toEqual([fresh]);
  });

  it("refuses a scheduled post with another account's media and stores no schedule", async () => {
    const owner = "create-targets-sched-owner@example.com";
    const borrower = "create-targets-sched-borrower@example.com";
    const picture = await privatePicture(owner);
    const borrowerId = (await signedInAccount(borrower)).id;

    const refused = await send(borrower, "POST", "/api/v1/statuses", {
      status: "later",
      media_ids: [picture.mediaId],
      scheduled_at: inSixMinutes(),
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject(mediaNotFound([picture.mediaId]));
    expect(JSON.stringify(refused.body)).not.toContain(picture.url);
    expect(await scheduledCount(borrowerId)).toBe(0);
  });

  it("refuses an edit to another account's media and keeps the note as it was", async () => {
    const owner = "create-targets-edit-owner@example.com";
    const borrower = "create-targets-edit-borrower@example.com";
    const picture = await privatePicture(owner);
    const own = await upload(borrower);
    const note = await postStatus(borrower, { status: "mine", media_ids: [own] });

    const refused = await send(borrower, "PUT", `/api/v1/statuses/${note.id}`, {
      status: "mine, and yours",
      media_ids: [own, picture.mediaId],
    });

    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject(mediaNotFound([picture.mediaId]));
    expect(JSON.stringify(refused.body)).not.toContain(picture.url);
    const after = await json(`/api/v1/statuses/${note.id}`, {
      headers: await authHeaders(borrower),
    });
    expect(read(Posted, after.body).media_attachments.map((media) => media.id)).toEqual([own]);
  });

  it("accepts an edit that keeps the note's own media", async () => {
    const author = "create-targets-edit-keep@example.com";
    const first = await upload(author);
    const second = await upload(author);
    const note = await postStatus(author, { status: "one", media_ids: [first] });

    const edited = await send(author, "PUT", `/api/v1/statuses/${note.id}`, {
      status: "two",
      media_ids: [first, second],
    });

    expect(edited.status).toBe(200);
    expect(read(Posted, edited.body).media_attachments.map((media) => media.id)).toEqual([
      first,
      second,
    ]);
  });

  it("drops a due scheduled post whose media is no longer the author's to attach", async () => {
    const owner = "create-targets-due-owner@example.com";
    const borrower = "create-targets-due-borrower@example.com";
    const picture = await privatePicture(owner);
    const borrowerId = (await signedInAccount(borrower)).id;
    // Rows stored before media_ids were checked at create time can name any media.
    const stored = await insertScheduledStatus(env.DB, {
      accountId: borrowerId,
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      params: {
        text: "never published",
        visibility: "public",
        spoiler_text: "",
        sensitive: false,
        language: null,
        media_ids: [picture.mediaId],
        media_attributes: [],
        poll: null,
        in_reply_to_id: null,
      },
    });
    expect(stored.isOk()).toBe(true);
    const listed = await json("/api/v1/scheduled_statuses", {
      headers: await authHeaders(borrower),
    });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(picture.url);

    expect(await processOutboxJob(env, { kind: "PublishScheduledStatuses" })).toBe("ok");

    expect(await statusCount(borrowerId)).toBe(0);
    expect(await scheduledCount(borrowerId)).toBe(0);
  });
});

const replyNotFound = { error: "The post you are trying to reply to does not appear to exist." };
const quoteNotFound = { error: "The post you are trying to quote does not appear to exist." };

describe("in_reply_to_id and quoted_status_id naming a status that is not shown", () => {
  it("refuses a reply, a scheduled reply and a quote when the author is suspended", async () => {
    const author = "create-targets-suspended@example.com";
    const replier = "create-targets-replier@example.com";
    const authorId = (await signedInAccount(author)).id;
    const replierId = (await signedInAccount(replier)).id;
    const target = await postStatus(author, { status: "before the suspension" });
    await suspend(authorId);

    const reply = await send(replier, "POST", "/api/v1/statuses", {
      status: "a reply",
      in_reply_to_id: target.id,
    });
    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject(replyNotFound);

    const scheduled = await send(replier, "POST", "/api/v1/statuses", {
      status: "a later reply",
      in_reply_to_id: target.id,
      scheduled_at: inSixMinutes(),
    });
    expect(scheduled.status).toBe(404);
    expect(scheduled.body).toMatchObject(replyNotFound);

    const quote = await send(replier, "POST", "/api/v1/statuses", {
      status: "a quote",
      quoted_status_id: target.id,
    });
    expect(quote.status).toBe(404);
    expect(quote.body).toMatchObject(quoteNotFound);

    expect(await statusCount(replierId)).toBe(0);
    expect(await scheduledCount(replierId)).toBe(0);
  });

  it("drops a due scheduled reply whose parent's author is suspended", async () => {
    const author = "create-targets-due-parent@example.com";
    const replier = "create-targets-due-replier@example.com";
    const authorId = (await signedInAccount(author)).id;
    const replierId = (await signedInAccount(replier)).id;
    const target = await postStatus(author, { status: "the parent" });
    const stored = await insertScheduledStatus(env.DB, {
      accountId: replierId,
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      params: {
        text: "never published",
        visibility: "public",
        spoiler_text: "",
        sensitive: false,
        language: null,
        media_ids: [],
        media_attributes: [],
        poll: null,
        in_reply_to_id: target.id,
      },
    });
    expect(stored.isOk()).toBe(true);
    await suspend(authorId);

    expect(await processOutboxJob(env, { kind: "PublishScheduledStatuses" })).toBe("ok");

    expect(await statusCount(replierId)).toBe(0);
    expect(await scheduledCount(replierId)).toBe(0);
  });
});
