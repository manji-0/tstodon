import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema, MastodonStatusPreviewSchema } from "./schemas";

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

const MutedStatusSchema = MastodonStatusPreviewSchema.extend({ muted: z.boolean() });

const credentials = async (email: string): Promise<{ id: string; username: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  const account = read(MastodonAccountPreviewSchema, response.body);
  return { id: account.id, username: account.username };
};

const postStatus = async (email: string, payload: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return read(MastodonStatusPreviewSchema, response.body).id;
};

const muteStatus = async (email: string, statusId: string, verb: "mute" | "unmute") =>
  json(`/api/v1/statuses/${statusId}/${verb}`, { method: "POST", headers: await auth(email) });

const getStatus = async (email: string, statusId: string) =>
  json(`/api/v1/statuses/${statusId}`, { headers: await auth(email) });

const homeIds = async (email: string): Promise<string[]> => {
  const response = await json("/api/v1/timelines/home", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(MastodonStatusPreviewSchema), response.body).map((status) => status.id);
};

const notificationStatusIds = async (email: string): Promise<string[]> => {
  const response = await json("/api/v1/notifications", { headers: await auth(email) });
  expect(response.status).toBe(200);
  const rows = read(
    z.array(
      z.object({
        type: z.string(),
        status: z.object({ id: z.string().min(1) }).nullable(),
      }),
    ),
    response.body,
  );
  return rows.flatMap((row) => (row.status ? [row.status.id] : []));
};

describe("conversation mutes", () => {
  it("mutes and unmutes a whole conversation from any reply", async () => {
    const author = "mute-root@example.com";
    const replier = "mute-reply@example.com";
    const rootId = await postStatus(author, { status: "conversation root" });
    const replyId = await postStatus(replier, {
      status: "conversation reply",
      in_reply_to_id: rootId,
    });

    const muted = await muteStatus(author, replyId, "mute");
    expect(muted.status).toBe(200);
    expect(read(MutedStatusSchema, muted.body).muted).toBe(true);

    const root = await getStatus(author, rootId);
    expect(read(MutedStatusSchema, root.body).muted).toBe(true);

    expect((await muteStatus(author, replyId, "unmute")).status).toBe(200);
    const unmuted = await getStatus(author, rootId);
    expect(read(MutedStatusSchema, unmuted.body).muted).toBe(false);
  });

  it("hides a muted conversation from the viewer's home timeline", async () => {
    const viewerEmail = "mute-home-viewer@example.com";
    const authorEmail = "mute-home-author@example.com";
    const viewer = await credentials(viewerEmail);
    const author = await credentials(authorEmail);
    expect(
      (
        await json(`/api/v1/accounts/${author.id}/follow`, {
          method: "POST",
          headers: await auth(viewerEmail),
        })
      ).status,
    ).toBe(200);

    const rootId = await postStatus(authorEmail, { status: "home root" });
    const replyId = await postStatus(authorEmail, {
      status: "home reply",
      in_reply_to_id: rootId,
    });
    expect(await homeIds(viewerEmail)).toContain(rootId);

    await muteStatus(viewerEmail, replyId, "mute");
    const after = await homeIds(viewerEmail);
    expect(after).not.toContain(rootId);
    expect(after).not.toContain(replyId);
    expect(viewer.id).not.toBe(author.id);
  });

  it("suppresses notifications that reference a muted conversation", async () => {
    const viewerEmail = "mute-notify-viewer@example.com";
    const replierEmail = "mute-notify-replier@example.com";
    const viewer = await credentials(viewerEmail);
    const rootId = await postStatus(viewerEmail, { status: "notify root" });
    const replyId = await postStatus(replierEmail, {
      status: `@${viewer.username} a reply`,
      in_reply_to_id: rootId,
    });
    expect(await notificationStatusIds(viewerEmail)).toContain(replyId);

    await muteStatus(viewerEmail, replyId, "mute");
    expect(await notificationStatusIds(viewerEmail)).not.toContain(replyId);
  });

  it("404s for an unknown status", async () => {
    const response = await muteStatus("mute-missing@example.com", "does-not-exist", "mute");
    expect(response.status).toBe(404);
  });
});
