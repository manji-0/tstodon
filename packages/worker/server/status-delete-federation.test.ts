import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount } from "@tstodon/api";
import { OutboxJob } from "@tstodon/domain";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";
import { listOutboundActivities } from "./outbox-store";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

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
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const DeleteActivitySchema = z.object({
  id: z.string(),
  type: z.literal("Delete"),
  actor: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  object: z.object({ id: z.string(), type: z.literal("Tombstone"), atomUri: z.string() }),
});

const account = async (email: string) => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(ApiAccount, response.body);
};

const postAndDelete = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const headers = { ...(await authHeaders(email)), "content-type": "application/json" };
  const created = await json("/api/v1/statuses", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  expect(created.status).toBe(200);
  const id = read(z.object({ id: z.string() }), created.body).id;
  expect((await json(`/api/v1/statuses/${id}`, { method: "DELETE", headers })).status).toBe(200);
  return id;
};

const deleteActivities = async (accountId: string) => {
  const activities = await listOutboundActivities(env.DB, accountId, 50);
  if (activities.isErr()) {
    throw new Error(activities.error.message);
  }
  return activities.value
    .filter((row) => row.kind === "Delete")
    .map((row) => read(DeleteActivitySchema, JSON.parse(row.payload_json)));
};

describe("status deletion federation", () => {
  it("sends a Tombstone Delete addressed like the public note", async () => {
    const author = await account("delete-public@example.com");
    const statusId = await postAndDelete("delete-public@example.com", { status: "soon gone" });
    const noteUri = `https://example.com/users/${author.username}/statuses/${statusId}`;
    const [activity] = await deleteActivities(author.id);
    expect(activity).toMatchObject({
      id: `${noteUri}#delete`,
      actor: `https://example.com/users/${author.username}`,
      to: [PUBLIC],
      object: { id: noteUri, type: "Tombstone", atomUri: noteUri },
    });
    expect(activity?.cc).toContain(`https://example.com/users/${author.username}/followers`);
  });

  it("addresses a followers-only note's Delete to the followers", async () => {
    const author = await account("delete-private@example.com");
    await postAndDelete("delete-private@example.com", {
      status: "followers only",
      visibility: "private",
    });
    const [activity] = await deleteActivities(author.id);
    expect(activity?.to).toEqual([`https://example.com/users/${author.username}/followers`]);
  });

  it("federates nothing for a direct note that mentions only local accounts", async () => {
    const author = await account("delete-direct@example.com");
    const friend = await account("delete-direct-friend@example.com");
    await postAndDelete("delete-direct@example.com", {
      status: `@${friend.username} just us`,
      visibility: "direct",
    });
    expect(await deleteActivities(author.id)).toEqual([]);
  });

  it("sends the Delete of a boosted post to its reach and to the local boosters' remote followers", async () => {
    const author = await account("delete-boosted@example.com");
    const booster = await account("delete-boosted-booster@example.com");
    const headers = async (email: string) => ({
      ...(await authHeaders(email)),
      "content-type": "application/json",
    });
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: await headers("delete-boosted@example.com"),
      body: JSON.stringify({ status: "boost me, then lose me" }),
    });
    expect(created.status).toBe(200);
    const statusId = read(z.object({ id: z.string() }), created.body).id;
    const noteUri = `https://example.com/users/${author.username}/statuses/${statusId}`;
    const boosted = await json(`/api/v1/statuses/${statusId}/reblog`, {
      method: "POST",
      headers: await headers("delete-boosted-booster@example.com"),
    });
    expect(boosted.status).toBe(200);
    // A remote follower of the booster only, and a remote stranger who favourited the post.
    const boosterFollower = await remoteActor("booster-fan", "fans.example");
    await env.DB.prepare(
      `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
       VALUES (?, ?, ?, 'Fulfilled', 'Accepted', ?)`,
    )
      .bind(crypto.randomUUID(), boosterFollower.actorUri, booster.id, new Date().toISOString())
      .run();
    const favouriter = await remoteActor("faver", "likes.example");
    expect(
      await favouriter.send({
        id: `${favouriter.actorUri}#likes/1`,
        type: "Like",
        object: noteUri,
      }),
    ).toBeLessThan(300);

    expect(
      (
        await json(`/api/v1/statuses/${statusId}`, {
          method: "DELETE",
          headers: await headers("delete-boosted@example.com"),
        })
      ).status,
    ).toBe(200);

    const rows = await listOutboundActivities(env.DB, author.id, 50);
    const deletes = (rows.isOk() ? rows.value : []).filter((row) => {
      if (row.kind !== "Delete") {
        return false;
      }
      return read(DeleteActivitySchema, JSON.parse(row.payload_json)).object.id === noteUri;
    });
    expect(deletes.length).toBeGreaterThan(0);
    const inboxes = new Set<string>();
    for (const row of deletes) {
      const job = OutboxJob.parse({ kind: "ExpandFollowers", activityId: row.id });
      if (job.isErr()) {
        throw new Error("expand job rejected");
      }
      const queued = await env.DB.prepare(
        "SELECT 1 FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NULL AND kind = 'Queued'",
      )
        .bind(row.id)
        .first();
      if (queued) {
        await processOutboxJob(env, job.value);
      }
      const { results } = await env.DB.prepare(
        "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL",
      )
        .bind(row.id)
        .all();
      for (const target of results ?? []) {
        inboxes.add(read(z.object({ inbox_url: z.string() }), target).inbox_url);
      }
    }
    expect([...inboxes].sort()).toEqual(
      [`${boosterFollower.actorUri}/inbox`, `${favouriter.actorUri}/inbox`].sort(),
    );
  });
});
