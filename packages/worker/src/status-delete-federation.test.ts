import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";
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
    headers: await accessAuthHeaders(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body);
};

const postAndDelete = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const headers = { ...(await accessAuthHeaders(email)), "content-type": "application/json" };
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
});
