import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { openStream as openSocket } from "../test/stream-fixture";
import { persistOutboxTarget } from "./outbox-store";
import { RemoteAccountId } from "./remote-account-id";

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const openStream = async (email: string) => openSocket({ email, query: "?stream=user" });

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  return { status: response.status, body: await response.json() };
};

const idOf = (body: unknown): string => {
  const parsed = schemaResult(z.object({ id: z.string() }))(body);
  if (parsed.isErr()) {
    throw new Error("status body rejected");
  }
  return parsed.value.id;
};

const post = async (email: string, status: string): Promise<string> => {
  const posted = await json(email, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  expect(posted.status).toBe(200);
  return idOf(posted.body);
};

const boost = async (email: string, statusId: string): Promise<string> => {
  const boosted = await json(email, `/api/v1/statuses/${statusId}/reblog`, {
    method: "POST",
    body: "{}",
  });
  expect(boosted.status).toBe(200);
  return idOf(boosted.body);
};

const follow = async (email: string, targetEmail: string) => {
  const target = await signedInAccount(targetEmail);
  const followed = await json(email, `/api/v1/accounts/${target.id}/follow`, {
    method: "POST",
    body: "{}",
  });
  expect(followed.status).toBe(200);
};

const followRemote = async (email: string, remote: Remote) => {
  const followed = await json(
    email,
    `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    { method: "POST", body: "{}" },
  );
  expect(followed.status).toBe(200);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${viewer.id}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const createRemote = async (author: Remote, slug: string): Promise<string> => {
  const object = {
    id: `${new URL(author.actorUri).origin}/notes/${slug}`,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: new Date().toISOString(),
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
  };
  expect(await author.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);
  return object.id;
};

const remoteStatusId = async (objectUri: string): Promise<string> => {
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
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

describe("followers of a local boost hear it go", () => {
  it("when the boosted local status is deleted", async () => {
    const author = "br-local-author@example.com";
    const booster = "br-local-booster@example.com";
    const follower = await openStream("br-local-follower@example.com");
    await follow("br-local-follower@example.com", booster);
    const original = await post(author, "boosted then deleted");
    const boostId = await boost(booster, original);
    expect((await follower.next()).event).toBe("update");

    const deleted = await json(author, `/api/v1/statuses/${original}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    expect(await follower.next()).toEqual({ stream: ["user"], event: "delete", payload: boostId });
    expect(await count("SELECT COUNT(*) AS n FROM statuses WHERE id = ?", boostId)).toBe(0);
    follower.close();
  });

  it("when the remote author deletes the boosted note", async () => {
    const booster = "br-remote-booster@example.com";
    const actor = await remoteActor("br-remote-author");
    const follower = await openStream("br-remote-follower@example.com");
    await follow("br-remote-follower@example.com", booster);
    const noteUri = await createRemote(actor, "br-remote-note");
    const boostId = await boost(booster, await remoteStatusId(noteUri));
    expect((await follower.next()).event).toBe("update");

    expect(await actor.send({ id: `${noteUri}/delete`, type: "Delete", object: noteUri })).toBe(
      202,
    );

    expect(await follower.next()).toEqual({ stream: ["user"], event: "delete", payload: boostId });
    expect(await count("SELECT COUNT(*) AS n FROM statuses WHERE id = ?", boostId)).toBe(0);
    follower.close();
  });
});

describe("purging a remote actor", () => {
  it("tells followers, drops thread marks and cancels queued deliveries", async () => {
    const booster = "br-purge-booster@example.com";
    const viewer = "br-purge-viewer@example.com";
    const actor = await remoteActor("br-purge-actor");
    const bystander = await remoteActor("br-purge-bystander", "other.example");
    const remoteFollower = await openStream("br-purge-follower@example.com");
    const boostFollower = await openStream("br-purge-boost-follower@example.com");
    await followRemote("br-purge-follower@example.com", actor);
    await follow("br-purge-boost-follower@example.com", booster);

    const noteUri = await createRemote(actor, "br-purge-note");
    const noteId = await remoteStatusId(noteUri);
    expect((await remoteFollower.next()).event).toBe("update");
    const boostId = await boost(booster, noteId);
    expect((await boostFollower.next()).event).toBe("update");

    const viewerId = (await signedInAccount(viewer)).id;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO status_mutes (account_id, thread_root_status_id) VALUES (?, ?)",
      ).bind(viewerId, noteId),
      env.DB.prepare(
        "INSERT INTO conversation_reads (account_id, conversation_id, last_read_status_id, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(viewerId, noteId, noteId, "2026-10-21T00:00:00.000Z"),
      env.DB.prepare(
        "INSERT INTO conversation_hides (account_id, conversation_id, hidden_status_id) VALUES (?, ?, ?)",
      ).bind(viewerId, noteId, noteId),
      env.DB.prepare(
        "INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, inbox_url) VALUES (?, ?, 'Queued', 2, ?)",
      ).bind("br-purge-delivery-gone", "br-purge-activity", `${actor.actorUri}/inbox`),
      env.DB.prepare(
        "INSERT INTO outbox_deliveries (id, activity_id, kind, attempt_count, inbox_url) VALUES (?, ?, 'Queued', 0, ?)",
      ).bind("br-purge-delivery-stays", "br-purge-activity", `${bystander.actorUri}/inbox`),
    ]);

    expect(
      await actor.send({
        id: "https://remote.example/activities/br-purge-delete",
        type: "Delete",
        object: actor.actorUri,
      }),
    ).toBe(202);

    expect(await remoteFollower.next()).toEqual({
      stream: ["user"],
      event: "delete",
      payload: noteId,
    });
    expect(await boostFollower.next()).toEqual({
      stream: ["user"],
      event: "delete",
      payload: boostId,
    });
    for (const table of ["status_mutes", "conversation_reads", "conversation_hides"]) {
      expect(await count(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, viewerId)).toBe(
        0,
      );
    }
    const delivery = async (id: string) =>
      env.DB.prepare("SELECT kind, reason_kind, http_status FROM outbox_deliveries WHERE id = ?")
        .bind(id)
        .first();
    expect(await delivery("br-purge-delivery-gone")).toEqual({
      kind: "Failed",
      reason_kind: "Permanent",
      http_status: 410,
    });
    expect(await delivery("br-purge-delivery-stays")).toMatchObject({ kind: "Queued" });

    // A delivery workflow that was mid-attempt cannot revive the cancelled row.
    await persistOutboxTarget(env.DB, "br-purge-activity", `${actor.actorUri}/inbox`, {
      kind: "Queued",
      attemptCount: 3,
    });
    expect(await delivery("br-purge-delivery-gone")).toMatchObject({ kind: "Failed" });
    remoteFollower.close();
    boostFollower.close();
  });
});
