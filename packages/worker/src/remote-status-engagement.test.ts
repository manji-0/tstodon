import { SELF, env } from "cloudflare:test";
import { OutboxJob } from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";
import { listOutboundActivities } from "./outbox-store";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const call = async (email: string, path: string, method = "GET") => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: await authHeaders(email),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const StatusSchema = z.object({
  id: z.string(),
  uri: z.string(),
  favourited: z.boolean(),
  reblogged: z.boolean(),
  bookmarked: z.boolean(),
  favourites_count: z.number(),
  reblogs_count: z.number(),
  account: z.object({ id: z.string() }),
  reblog: z
    .object({
      id: z.string(),
      uri: z.string(),
      account: z.object({ id: z.string() }),
      reblogged: z.boolean(),
      reblogs_count: z.number(),
    })
    .nullable(),
});

const status = (body: unknown) => read(StatusSchema, body);
const statuses = (body: unknown) => read(z.array(StatusSchema), body);
const accountIds = (body: unknown) =>
  read(z.array(z.object({ id: z.string() })), body).map((account) => account.id);

/** A note by `author`, delivered to this instance; resolves to its id here and its URI. */
const remoteNote = async (
  author: Remote,
  slug: string,
  audience: Readonly<{ to: string[]; cc: string[] }> = {
    to: [PUBLIC],
    cc: [`${author.actorUri}/followers`],
  },
): Promise<Readonly<{ id: string; uri: string }>> => {
  const uri = `${new URL(author.actorUri).origin}/notes/${slug}`;
  expect(
    await author.send({
      id: `${uri}/activity`,
      type: "Create",
      object: {
        id: uri,
        type: "Note",
        attributedTo: author.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        ...audience,
      },
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(uri)
    .first<{ id: string }>();
  expect(row).not.toBeNull();
  return { id: row?.id ?? "", uri };
};

const ActivitySchema = z.object({
  id: z.string(),
  type: z.string(),
  actor: z.string(),
  object: z.union([
    z.string(),
    z.object({ id: z.string(), type: z.string(), object: z.string() }).loose(),
  ]),
});

/**
 * The newest queued activity of `type` from the account, expanded as the
 * queue would, with the inboxes it goes to.
 */
const delivered = async (email: string, type: string) => {
  const account = await signedInAccount(email);
  const rows = await listOutboundActivities(env.DB, account.id, 50);
  const row = (rows.isOk() ? rows.value : []).find((candidate) => candidate.kind === type);
  if (!row) {
    return undefined;
  }
  const job = OutboxJob.parse({ kind: "ExpandFollowers", activityId: row.id });
  if (job.isErr()) {
    throw new Error("expand job rejected");
  }
  await processOutboxJob(env, job.value);
  const { results } = await env.DB.prepare(
    "SELECT inbox_url FROM outbox_deliveries WHERE activity_id = ? AND inbox_url IS NOT NULL ORDER BY inbox_url",
  )
    .bind(row.id)
    .all<{ inbox_url: string }>();
  return {
    activity: read(ActivitySchema, JSON.parse(row.payload_json)),
    inboxes: (results ?? []).map((target) => target.inbox_url),
  };
};

const localAccountId = async (email: string) => (await signedInAccount(email)).id;

/** `email` follows the remote actor, and the actor accepts. */
const acceptedFollow = async (email: string, remote: Remote) => {
  const remoteId = RemoteAccountId.encode(remote.actorUri);
  expect((await call(email, `/api/v1/accounts/${remoteId}/follow`, "POST")).status).toBe(200);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(await localAccountId(email), remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${email}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

describe("favouriting a remote status", () => {
  it("counts the favourite, lists the account, and federates Like then Undo to the author", async () => {
    const author = await remoteActor("engage-fav-author");
    const fan = "engage-fav@example.com";
    const note = await remoteNote(author, "engage-fav");

    const favourited = await call(fan, `/api/v1/statuses/${note.id}/favourite`, "POST");
    expect(favourited.status).toBe(200);
    expect(status(favourited.body)).toMatchObject({
      id: note.id,
      favourited: true,
      favourites_count: 1,
    });
    expect(status((await call(fan, `/api/v1/statuses/${note.id}`)).body)).toMatchObject({
      favourited: true,
      favourites_count: 1,
    });
    expect(accountIds((await call(fan, `/api/v1/statuses/${note.id}/favourited_by`)).body)).toEqual(
      [await localAccountId(fan)],
    );
    expect(statuses((await call(fan, "/api/v1/favourites")).body).map((s) => s.id)).toEqual([
      note.id,
    ]);
    const like = await delivered(fan, "Like");
    expect(like?.activity.object).toBe(note.uri);
    expect(like?.inboxes).toEqual([`${author.actorUri}/inbox`]);

    const again = await call(fan, `/api/v1/statuses/${note.id}/favourite`, "POST");
    expect(status(again.body).favourites_count).toBe(1);

    const unfavourited = await call(fan, `/api/v1/statuses/${note.id}/unfavourite`, "POST");
    expect(unfavourited.status).toBe(200);
    expect(status(unfavourited.body)).toMatchObject({ favourited: false, favourites_count: 0 });
    expect(statuses((await call(fan, "/api/v1/favourites")).body)).toEqual([]);
    expect(accountIds((await call(fan, `/api/v1/statuses/${note.id}/favourited_by`)).body)).toEqual(
      [],
    );
    const undo = await delivered(fan, "Undo");
    expect(undo?.activity.object).toMatchObject({
      type: "Like",
      id: like?.activity.id,
      object: note.uri,
    });
    expect(undo?.inboxes).toEqual([`${author.actorUri}/inbox`]);
  });

  it("refuses a followers-only status the viewer may not see", async () => {
    const author = await remoteActor("engage-private-author");
    const stranger = "engage-private@example.com";
    const note = await remoteNote(author, "engage-private", {
      to: [`${author.actorUri}/followers`],
      cc: [],
    });

    expect((await call(stranger, `/api/v1/statuses/${note.id}/favourite`, "POST")).status).toBe(
      404,
    );
    expect((await call(stranger, `/api/v1/statuses/${note.id}/reblog`, "POST")).status).toBe(404);
    expect((await call(stranger, `/api/v1/statuses/${note.id}/bookmark`, "POST")).status).toBe(404);
    expect(await delivered(stranger, "Like")).toBeUndefined();
  });
});

describe("boosting a remote status", () => {
  it("shows the boost to local followers, counts it, and federates Announce then Undo", async () => {
    const author = await remoteActor("engage-boost-author");
    const booster = "engage-booster@example.com";
    const follower = "engage-boost-follower@example.com";
    const boosterId = await localAccountId(booster);
    expect((await call(follower, `/api/v1/accounts/${boosterId}/follow`, "POST")).status).toBe(200);
    const note = await remoteNote(author, "engage-boost");

    const reblogged = await call(booster, `/api/v1/statuses/${note.id}/reblog`, "POST");
    expect(reblogged.status).toBe(200);
    const boost = status(reblogged.body);
    expect(boost).toMatchObject({
      account: { id: boosterId },
      reblog: {
        id: note.id,
        uri: note.uri,
        account: { id: RemoteAccountId.encode(author.actorUri) },
        reblogged: true,
        reblogs_count: 1,
      },
    });
    expect(boost.id).not.toBe(note.id);

    const [entry] = statuses((await call(follower, "/api/v1/timelines/home")).body);
    expect(entry).toMatchObject({
      id: boost.id,
      account: { id: boosterId },
      reblog: { id: note.id, reblogged: false, reblogs_count: 1 },
    });
    expect(
      accountIds((await call(follower, `/api/v1/statuses/${note.id}/reblogged_by`)).body),
    ).toEqual([boosterId]);
    const announce = await delivered(booster, "Announce");
    expect(announce?.activity.object).toBe(note.uri);
    expect(announce?.inboxes).toEqual([`${author.actorUri}/inbox`]);

    const again = await call(booster, `/api/v1/statuses/${note.id}/reblog`, "POST");
    expect(status(again.body).id).toBe(boost.id);

    const unreblogged = await call(booster, `/api/v1/statuses/${note.id}/unreblog`, "POST");
    expect(unreblogged.status).toBe(200);
    expect(status(unreblogged.body)).toMatchObject({
      id: note.id,
      reblogged: false,
      reblogs_count: 0,
    });
    expect(statuses((await call(follower, "/api/v1/timelines/home")).body)).toEqual([]);
    const undo = await delivered(booster, "Undo");
    expect(undo?.activity.object).toMatchObject({ type: "Announce", id: announce?.activity.id });
    expect(undo?.inboxes).toEqual([`${author.actorUri}/inbox`]);
  });

  it("refuses a followers-only status even to the author's followers", async () => {
    const author = await remoteActor("engage-boost-private-author");
    const booster = "engage-boost-private@example.com";
    const note = await remoteNote(author, "engage-boost-private", {
      to: [`${author.actorUri}/followers`],
      cc: [],
    });
    await acceptedFollow(booster, author);
    expect((await call(booster, `/api/v1/statuses/${note.id}`)).status).toBe(200);

    expect((await call(booster, `/api/v1/statuses/${note.id}/reblog`, "POST")).status).toBe(404);
  });

  it("goes with the remote status when its author deletes it", async () => {
    const author = await remoteActor("engage-delete-author");
    const fan = "engage-delete@example.com";
    const note = await remoteNote(author, "engage-delete");
    expect((await call(fan, `/api/v1/statuses/${note.id}/reblog`, "POST")).status).toBe(200);
    expect((await call(fan, `/api/v1/statuses/${note.id}/favourite`, "POST")).status).toBe(200);
    expect((await call(fan, `/api/v1/statuses/${note.id}/bookmark`, "POST")).status).toBe(200);

    expect(
      await author.send({
        id: `${note.uri}#delete`,
        type: "Delete",
        object: { id: note.uri, type: "Tombstone" },
      }),
    ).toBe(202);

    const fanId = await localAccountId(fan);
    expect(statuses((await call(fan, `/api/v1/accounts/${fanId}/statuses`)).body)).toEqual([]);
    expect(statuses((await call(fan, "/api/v1/favourites")).body)).toEqual([]);
    expect(statuses((await call(fan, "/api/v1/bookmarks")).body)).toEqual([]);
  });
});

describe("bookmarking a remote status", () => {
  it("lists remote and local bookmarks together, newest status first, with a cursor", async () => {
    const author = await remoteActor("engage-bookmark-author");
    const reader = "engage-bookmark@example.com";
    const older = await remoteNote(author, "engage-bookmark-older");
    const posted = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(reader)) },
      body: JSON.stringify({ status: "a local note to keep" }),
    });
    const local = read(z.object({ id: z.string() }), await posted.json());
    const newer = await remoteNote(author, "engage-bookmark-newer");
    for (const id of [older.id, local.id, newer.id]) {
      const bookmarked = await call(reader, `/api/v1/statuses/${id}/bookmark`, "POST");
      expect(bookmarked.status).toBe(200);
      expect(status(bookmarked.body).bookmarked).toBe(true);
    }

    const page = await call(reader, "/api/v1/bookmarks?limit=2");
    expect(statuses(page.body).map((s) => s.id)).toEqual([newer.id, local.id]);
    expect(page.headers.get("link")).toContain(`max_id=${local.id}`);
    const next = await call(reader, `/api/v1/bookmarks?limit=2&max_id=${local.id}`);
    expect(statuses(next.body).map((s) => s.id)).toEqual([older.id]);

    const removed = await call(reader, `/api/v1/statuses/${newer.id}/unbookmark`, "POST");
    expect(status(removed.body).bookmarked).toBe(false);
    expect(statuses((await call(reader, "/api/v1/bookmarks")).body).map((s) => s.id)).toEqual([
      local.id,
      older.id,
    ]);
  });
});
