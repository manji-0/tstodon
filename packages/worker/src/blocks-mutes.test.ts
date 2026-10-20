import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { schemaResult } from "@tstodon/core";
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

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const postStatus = async (email: string, text: string): Promise<{ id: string }> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ status: text }),
  });
  expect(response.status).toBe(200);
  return read(MastodonStatusPreviewSchema, response.body);
};

const follow = async (followerEmail: string, targetId: string) =>
  json(`/api/v1/accounts/${targetId}/follow`, {
    method: "POST",
    headers: await auth(followerEmail),
  });

const homeIds = async (email: string): Promise<string[]> => {
  const response = await json("/api/v1/timelines/home", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(MastodonStatusPreviewSchema), response.body).map((status) => status.id);
};

const action = async (email: string, targetId: string, verb: string) =>
  json(`/api/v1/accounts/${targetId}/${verb}`, {
    method: "POST",
    headers: await auth(email),
  });

describe("blocks and mutes", () => {
  it("requires authentication", async () => {
    expect((await json("/api/v1/blocks")).status).toBe(401);
    expect((await json("/api/v1/mutes")).status).toBe(401);
  });

  it("blocks, hides both timelines, lists, and unblocks", async () => {
    const aId = await accountIdFor("blk-a@example.com");
    const bId = await accountIdFor("blk-b@example.com");
    const bStatus = await postStatus("blk-b@example.com", "b before block");
    const aStatus = await postStatus("blk-a@example.com", "a before block");

    expect((await follow("blk-a@example.com", bId)).status).toBe(200);
    expect((await follow("blk-b@example.com", aId)).status).toBe(200);
    expect(await homeIds("blk-a@example.com")).toContain(bStatus.id);
    expect(await homeIds("blk-b@example.com")).toContain(aStatus.id);

    const blocked = await action("blk-a@example.com", bId, "block");
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ id: bId, blocking: true });

    // A no longer sees B, and B no longer sees A (blocked_by suppression).
    expect(await homeIds("blk-a@example.com")).not.toContain(bStatus.id);
    expect(await homeIds("blk-b@example.com")).not.toContain(aStatus.id);

    const bRelationship = await json(`/api/v1/accounts/relationships?id[]=${aId}`, {
      headers: await auth("blk-b@example.com"),
    });
    expect(bRelationship.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: aId, blocked_by: true })]),
    );

    const blocks = await json("/api/v1/blocks", { headers: await auth("blk-a@example.com") });
    expect(read(z.array(MastodonAccountPreviewSchema), blocks.body).map((x) => x.id)).toContain(
      bId,
    );

    const unblocked = await action("blk-a@example.com", bId, "unblock");
    expect(unblocked.body).toMatchObject({ blocking: false });
    expect(await homeIds("blk-a@example.com")).toContain(bStatus.id);
    expect(await homeIds("blk-b@example.com")).toContain(aStatus.id);

    const blocksAfter = await json("/api/v1/blocks", {
      headers: await auth("blk-a@example.com"),
    });
    expect(read(z.array(MastodonAccountPreviewSchema), blocksAfter.body)).toHaveLength(0);
  });

  it("mutes timeline content and gates notifications separately", async () => {
    await accountIdFor("mute-a@example.com");
    const bId = await accountIdFor("mute-b@example.com");
    const bStatus = await postStatus("mute-b@example.com", "b before mute");
    const aStatus = await postStatus("mute-a@example.com", "a favourite target");
    expect((await follow("mute-a@example.com", bId)).status).toBe(200);

    const favourite = await json(`/api/v1/statuses/${aStatus.id}/favourite`, {
      method: "POST",
      headers: await auth("mute-b@example.com"),
    });
    expect(favourite.status).toBe(200);

    const notificationSenders = async (email: string): Promise<string[]> => {
      const response = await json("/api/v1/notifications", { headers: await auth(email) });
      expect(response.status).toBe(200);
      return read(
        z.array(z.object({ type: z.string(), account: MastodonAccountPreviewSchema })),
        response.body,
      )
        .filter((item) => item.type === "favourite")
        .map((item) => item.account.id);
    };
    expect(await notificationSenders("mute-a@example.com")).toContain(bId);

    const muted = await json(`/api/v1/accounts/${bId}/mute`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("mute-a@example.com")) },
      body: JSON.stringify({ notifications: false }),
    });
    expect(muted.status).toBe(200);
    expect(muted.body).toMatchObject({ muting: true, muting_notifications: false });
    expect(await homeIds("mute-a@example.com")).not.toContain(bStatus.id);
    // Timeline hidden but notifications still delivered when notifications=false.
    expect(await notificationSenders("mute-a@example.com")).toContain(bId);

    const mutedNotify = await json(`/api/v1/accounts/${bId}/mute`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await auth("mute-a@example.com")) },
      body: JSON.stringify({ notifications: true }),
    });
    expect(mutedNotify.body).toMatchObject({ muting: true, muting_notifications: true });
    expect(await notificationSenders("mute-a@example.com")).not.toContain(bId);

    const mutes = await json("/api/v1/mutes", { headers: await auth("mute-a@example.com") });
    expect(read(z.array(MastodonAccountPreviewSchema), mutes.body).map((x) => x.id)).toContain(bId);

    const unmuted = await action("mute-a@example.com", bId, "unmute");
    expect(unmuted.body).toMatchObject({ muting: false });
    expect(await homeIds("mute-a@example.com")).toContain(bStatus.id);
    expect(await notificationSenders("mute-a@example.com")).toContain(bId);
  });

  it("rejects blocking yourself", async () => {
    const selfId = await accountIdFor("blk-self@example.com");
    const response = await action("blk-self@example.com", selfId, "block");
    expect(response.status).toBe(400);
  });

  it("returns 404 for an unknown target", async () => {
    await accountIdFor("blk-missing@example.com");
    const response = await action("blk-missing@example.com", "does-not-exist", "block");
    expect(response.status).toBe(404);
  });
});
