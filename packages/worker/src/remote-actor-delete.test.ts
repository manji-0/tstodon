import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const call = (path: string, init?: RequestInit) => SELF.fetch(`https://example.com${path}`, init);

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const post = async (email: string, path: string, body: unknown = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });

const localUser = async (email: string) =>
  read(
    z.object({ id: z.string(), username: z.string() }),
    await (
      await call("/api/v1/accounts/verify_credentials", { headers: await authHeaders(email) })
    ).json(),
  );

const localStatus = async (email: string, text: string) =>
  read(
    z.object({ id: z.string(), uri: z.string() }),
    await (await post(email, "/api/v1/statuses", { status: text })).json(),
  );

const storedNote = async (author: Remote, slug: string): Promise<string> => {
  const object = {
    id: `https://remote.example/notes/${slug}`,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-10-20T00:00:00.000Z",
    to: [PUBLIC],
  };
  expect(
    await author.send({
      id: `https://remote.example/activities/create-${slug}`,
      type: "Create",
      object,
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(object.id)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("remote note was not stored");
  }
  return row.id;
};

const count = async (sql: string, ...binds: string[]): Promise<number> =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

const accountStatus = async (id: string): Promise<number> =>
  (await call(`/api/v1/accounts/${id}`)).status;

const followerUris = async (username: string): Promise<string[]> => {
  const collection = read(
    z.object({ orderedItems: z.array(z.string()) }),
    await (await call(`/users/${username}/followers`)).json(),
  );
  return collection.orderedItems;
};

const selfDelete = (actor: Remote, n = 1) =>
  actor.send({
    id: `https://remote.example/activities/delete-self-${actor.actorUri.split("/").pop()}-${n}`,
    type: "Delete",
    object: actor.actorUri,
  });

describe("remote actor deleting its account", () => {
  it("purges the actor and everything cached for it", async () => {
    const email = "actor-delete-local@example.com";
    const keeperEmail = "actor-delete-keeper@example.com";
    const user = await localUser(email);
    const gone = await remoteActor("leaving");
    const stays = await remoteActor("staying");
    const goneId = RemoteAccountId.encode(gone.actorUri);
    const staysId = RemoteAccountId.encode(stays.actorUri);

    const noteId = await storedNote(gone, "leaving-note");
    const staysNoteId = await storedNote(stays, "staying-note");
    const mine = await localStatus(email, "hello from the local side");

    // Followers, a like and the notifications they produced.
    for (const actor of [gone, stays]) {
      const name = actor.actorUri.split("/").pop();
      expect(
        await actor.send({
          id: `https://remote.example/activities/follow-${name}`,
          type: "Follow",
          object: `https://example.com/users/${user.username}`,
        }),
      ).toBe(202);
      expect(
        await actor.send({
          id: `https://remote.example/activities/like-${name}`,
          type: "Like",
          object: mine.uri,
        }),
      ).toBe(202);
    }
    // Per-viewer state keyed by the remote account.
    expect((await post(email, `/api/v1/accounts/${goneId}/mute`)).status).toBe(200);
    expect((await post(keeperEmail, `/api/v1/accounts/${goneId}/block`)).status).toBe(200);
    expect((await post(email, `/api/v1/accounts/${goneId}/note`, { comment: "hm" })).status).toBe(
      200,
    );
    expect((await post(email, `/api/v1/accounts/${goneId}/endorse`)).status).toBe(200);

    expect(await followerUris(user.username)).toEqual(
      expect.arrayContaining([gone.actorUri, stays.actorUri]),
    );
    expect(await accountStatus(goneId)).toBe(200);
    expect((await call(`/api/v1/statuses/${noteId}`)).status).toBe(200);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM notifications WHERE from_actor_uri = ?",
        gone.actorUri,
      ),
    ).toBeGreaterThan(0);

    const before = read(
      z.object({ followers_count: z.number(), following_count: z.number() }),
      await (await call(`/api/v1/accounts/${user.id}`)).json(),
    );

    expect(await selfDelete(gone)).toBe(202);

    expect(await accountStatus(goneId)).toBe(404);
    expect((await call(`/api/v1/statuses/${noteId}`)).status).toBe(404);
    expect(await followerUris(user.username)).toEqual([stays.actorUri]);
    expect(await accountStatus(staysId)).toBe(200);
    expect((await call(`/api/v1/statuses/${staysNoteId}`)).status).toBe(200);

    const notifications = read(
      z.array(z.object({ account: z.object({ id: z.string() }) })),
      await (await call("/api/v1/notifications", { headers: await authHeaders(email) })).json(),
    );
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.map((entry) => entry.account.id)).not.toContain(goneId);
    expect(notifications.map((entry) => entry.account.id)).toContain(staysId);

    for (const table of ["notifications", "blocks", "mutes", "endorsements", "account_notes"]) {
      const column = table === "notifications" ? "from_actor_uri" : "target_actor_uri";
      expect(
        await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, gone.actorUri),
      ).toBe(0);
    }
    for (const [table, column] of [
      ["remote_statuses", "actor_uri"],
      ["remote_follows", "remote_actor_uri"],
      ["remote_favourites", "remote_actor_uri"],
      ["remote_actors", "actor_uri"],
    ] as const) {
      expect(
        await count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, gone.actorUri),
      ).toBe(0);
    }

    // Local counts come from local follows only and stay put.
    const after = read(
      z.object({ followers_count: z.number(), following_count: z.number() }),
      await (await call(`/api/v1/accounts/${user.id}`)).json(),
    );
    expect(after).toEqual(before);
  });

  it("acknowledges a repeated Delete from an actor that is already gone", async () => {
    const gone = await remoteActor("deleted-twice");
    expect(await selfDelete(gone)).toBe(202);
    expect(await selfDelete(gone, 2)).toBe(202);
  });

  it("does not let one actor delete another", async () => {
    const victim = await remoteActor("delete-victim");
    const attacker = await remoteActor("delete-attacker", "elsewhere.example");
    const noteId = await storedNote(victim, "victim-note");
    const victimId = RemoteAccountId.encode(victim.actorUri);

    expect(
      await attacker.send({
        id: "https://elsewhere.example/activities/delete-victim",
        type: "Delete",
        object: victim.actorUri,
      }),
    ).toBe(202);
    expect(
      await attacker.send({
        id: "https://elsewhere.example/activities/delete-victim-embedded",
        type: "Delete",
        object: { id: victim.actorUri, type: "Tombstone" },
      }),
    ).toBe(202);

    expect(await accountStatus(victimId)).toBe(200);
    expect((await call(`/api/v1/statuses/${noteId}`)).status).toBe(200);
  });

  it("accepts the actor as an embedded object", async () => {
    const gone = await remoteActor("embedded-delete");
    const goneId = RemoteAccountId.encode(gone.actorUri);
    expect(
      await gone.send({
        id: "https://remote.example/activities/delete-embedded",
        type: "Delete",
        object: { id: gone.actorUri, type: "Person" },
      }),
    ).toBe(202);
    expect(await accountStatus(goneId)).toBe(404);
  });
});
