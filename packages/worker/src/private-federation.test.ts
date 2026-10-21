import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { listOutboundActivities } from "./outbox-store";

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

const post = async (email: string, status: string, visibility: string) =>
  read(
    z.object({ id: z.string(), uri: z.string() }),
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await accessAuthHeaders(email)) },
        body: JSON.stringify({ status, visibility }),
      })
    ).body,
  );

describe("non-public notes on the federation surface", () => {
  it("keeps direct notes off followers and private notes off public endpoints", async () => {
    const email = "private-federation-author@example.com";
    const account = read(
      z.object({ id: z.string(), username: z.string() }),
      (
        await json("/api/v1/accounts/verify_credentials", {
          headers: await accessAuthHeaders(email),
        })
      ).body,
    );
    // An accepted remote follower, so any delivery to followers would happen.
    const follower = await remoteActor("private-federation-follower");
    await env.DB.prepare(
      `INSERT INTO remote_follows (id, remote_actor_uri, target_account_id, remote_request_kind, follow_kind, created_at)
       VALUES ('private-federation-follow', ?, ?, 'Fulfilled', 'Accepted', '2026-10-21T00:00:00.000Z')`,
    )
      .bind(follower.actorUri, account.id)
      .run();

    const direct = await post(email, "just for me", "direct");
    const privateNote = await post(email, "followers only", "private");
    const publicNote = await post(email, "hello everyone", "public");

    // Only the followers-only and public notes are queued for delivery.
    const activities = await listOutboundActivities(env.DB, account.id, 20);
    expect(activities.isOk()).toBe(true);
    const created = (activities.isOk() ? activities.value : []).flatMap((row) => {
      const payload = schemaResult(
        z.object({ type: z.string(), object: z.object({ id: z.string() }) }),
      )(JSON.parse(row.payload_json));
      return payload.isOk() && payload.value.type === "Create" ? [payload.value.object.id] : [];
    });
    expect(created.toSorted()).toEqual([privateNote.uri, publicNote.uri].toSorted());

    // The note objects open only for public and unlisted visibility.
    const objectPath = (uri: string) => new URL(uri).pathname;
    expect((await json(objectPath(publicNote.uri))).status).toBe(200);
    expect((await json(objectPath(privateNote.uri))).status).toBe(404);
    expect((await json(objectPath(direct.uri))).status).toBe(404);

    // The outbox lists the public note's Create only.
    const outbox = read(
      z.object({ orderedItems: z.array(z.object({ type: z.string(), object: z.unknown() })) }),
      (await json(`/users/${account.username}/outbox`)).body,
    );
    expect(
      outbox.orderedItems.map((item) =>
        typeof item.object === "object" && item.object !== null
          ? Reflect.get(item.object, "id")
          : item.object,
      ),
    ).toEqual([publicNote.uri]);
  });
});
