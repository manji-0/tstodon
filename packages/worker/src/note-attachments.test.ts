import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { sampleUploadFor } from "../test/image-fixtures";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { Hono } from "hono";
import { authHeaders } from "../test/auth-fixture";
import { findAccountById } from "./account-store";
import { announceNoteUpdate } from "./local-status-update";
import { processOutboxJob } from "./outbox-job";
import { getUsersByUsernameStatusesById } from "./routes/activitypub";
import { parseInstanceIdentity } from "./runtime-config";
import { insertScheduledStatus } from "./scheduled-status-store";
import { findStatusById } from "./status-store";

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

const upload = async (email: string, name: string, type: string): Promise<string> => {
  const form = new FormData();
  form.set("file", new File([sampleUploadFor(type)], name, { type }));
  const response = await json("/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const PostedStatus = z.object({
  id: z.string(),
  uri: z.string(),
  account: z.object({ id: z.string(), username: z.string() }),
  media_attachments: z.array(z.object({ id: z.string(), url: z.string() })),
});

/** The media's public URL, as the Mastodon API shows it to the author. */
const urlsById = (status: z.infer<typeof PostedStatus>) =>
  new Map(status.media_attachments.map((media) => [media.id, media.url]));

const Activity = z.object({
  type: z.string(),
  object: z.looseObject({ id: z.string(), attachment: z.unknown().optional() }),
});

/** The note objects the account's queued activities of `kind` carry, oldest first. */
const queuedNotes = async (accountId: string, kind: "Create" | "Update") => {
  const rows = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = ? ORDER BY rowid",
  )
    .bind(accountId, kind)
    .all<{ payload_json: string }>();
  return rows.results.map((row) => read(Activity, JSON.parse(row.payload_json)).object);
};

/** A D1 binding whose media lookup by id fails, as when D1 drops the connection. */
const failingMediaLookup = (db: D1Database): D1Database =>
  new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (/FROM media_attachments WHERE id /.test(sql)) {
            throw new Error("D1_ERROR: Network connection lost.");
          }
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function"
        ? (...args: unknown[]) => Reflect.apply(value, target, args)
        : value;
    },
  });

const accountIdOf = async (email: string): Promise<string> => {
  const credentials = await json("/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  return read(z.object({ id: z.string().min(1) }), credentials.body).id;
};

describe("note attachments", () => {
  it("federates a status's media in order as Mastodon's Document attachments", async () => {
    const email = "note-attachments-create@example.com";
    const photo = await upload(email, "photo.png", "image/png");
    const clip = await upload(email, "clip.jpg", "image/jpeg");
    const posted = await send(email, "POST", "/api/v1/statuses", {
      status: "two pictures",
      media_ids: [clip, photo],
      media_attributes: [{ id: photo, description: "a described photo", focus: "0.5,-0.25" }],
    });
    expect(posted.status).toBe(200);
    const status = read(PostedStatus, posted.body);
    const urls = urlsById(status);
    const expected = [
      {
        type: "Document",
        mediaType: "image/jpeg",
        url: urls.get(clip),
        name: null,
        blurhash: expect.any(String),
        width: 800,
        height: 600,
      },
      {
        type: "Document",
        mediaType: "image/png",
        url: urls.get(photo),
        name: "a described photo",
        blurhash: expect.any(String),
        width: 40,
        height: 30,
        focalPoint: [0.5, -0.25],
      },
    ];

    const [created] = await queuedNotes(status.account.id, "Create");
    expect(created?.id).toBe(status.uri);
    expect(created?.attachment).toEqual(expected);

    const outbox = await json(`/users/${status.account.username}/outbox`);
    const items = read(z.object({ orderedItems: z.array(Activity) }), outbox.body).orderedItems;
    expect(items.find((item) => item.object.id === status.uri)?.object.attachment).toEqual(
      expected,
    );
  });

  it("sends an Update with the edited media and descriptions", async () => {
    const email = "note-attachments-edit@example.com";
    const first = await upload(email, "first.png", "image/png");
    const second = await upload(email, "second.png", "image/png");
    const posted = await send(email, "POST", "/api/v1/statuses", {
      status: "before the edit",
      media_ids: [first, second],
    });
    expect(posted.status).toBe(200);
    const status = read(PostedStatus, posted.body);
    const urls = urlsById(status);

    const edited = await send(email, "PUT", `/api/v1/statuses/${status.id}`, {
      status: "after the edit",
      media_ids: [second],
      media_attributes: [{ id: second, description: "described on edit" }],
    });
    expect(edited.status).toBe(200);

    const expected = [
      {
        type: "Document",
        mediaType: "image/png",
        url: urls.get(second),
        name: "described on edit",
        blurhash: expect.any(String),
        width: 40,
        height: 30,
      },
    ];
    const updates = await queuedNotes(status.account.id, "Update");
    expect(updates.at(-1)?.attachment).toEqual(expected);

    const fetched = await json(`/users/${status.account.username}/statuses/${status.id}`);
    expect(fetched.status).toBe(200);
    const note = read(z.looseObject({ attachment: z.unknown().optional() }), fetched.body);
    expect(note.attachment).toEqual(expected);
  });

  it("keeps the media_ids order, not the upload order, when the status is read back", async () => {
    const email = "note-attachments-order@example.com";
    const first = await upload(email, "first.png", "image/png");
    const second = await upload(email, "second.png", "image/png");
    const third = await upload(email, "third.png", "image/png");
    const posted = await send(email, "POST", "/api/v1/statuses", {
      status: "out of upload order",
      media_ids: [third, first, second],
    });
    expect(posted.status).toBe(200);
    const status = read(PostedStatus, posted.body);
    const urls = urlsById(status);

    const readBack = async () => {
      const single = await json(`/api/v1/statuses/${status.id}`, {
        headers: await authHeaders(email),
      });
      const listed = await json(`/api/v1/accounts/${status.account.id}/statuses`, {
        headers: await authHeaders(email),
      });
      const fetched = await json(`/users/${status.account.username}/statuses/${status.id}`);
      const note = read(
        z.object({ attachment: z.array(z.object({ url: z.string() })) }),
        fetched.body,
      );
      const timeline = read(z.array(PostedStatus), listed.body);
      return {
        api: read(PostedStatus, single.body).media_attachments.map((media) => media.id),
        timeline: timeline
          .find((entry) => entry.id === status.id)
          ?.media_attachments.map((media) => media.id),
        note: note.attachment.map((attachment) => attachment.url),
      };
    };

    expect(await readBack()).toEqual({
      api: [third, first, second],
      timeline: [third, first, second],
      note: [third, first, second].map((id) => urls.get(id)),
    });

    const edited = await send(email, "PUT", `/api/v1/statuses/${status.id}`, {
      status: "reordered",
      media_ids: [second, third, first],
    });
    expect(edited.status).toBe(200);
    expect(read(PostedStatus, edited.body).media_attachments.map((media) => media.id)).toEqual([
      second,
      third,
      first,
    ]);
    expect(await readBack()).toEqual({
      api: [second, third, first],
      timeline: [second, third, first],
      note: [second, third, first].map((id) => urls.get(id)),
    });
    const updates = await queuedNotes(status.account.id, "Update");
    expect(
      read(z.array(z.object({ url: z.string() })), updates.at(-1)?.attachment).map(
        (attachment) => attachment.url,
      ),
    ).toEqual([second, third, first].map((id) => urls.get(id)));
  });

  it("sends an empty attachment list for a note without media", async () => {
    const email = "note-attachments-none@example.com";
    const posted = await send(email, "POST", "/api/v1/statuses", { status: "words only" });
    expect(posted.status).toBe(200);
    const status = read(PostedStatus, posted.body);
    const [created] = await queuedNotes(status.account.id, "Create");
    expect(created?.attachment).toEqual([]);
  });

  it("federates the media of a scheduled post when it publishes", async () => {
    const email = "note-attachments-scheduled@example.com";
    const media = await upload(email, "later.png", "image/png");
    const credentials = await json("/api/v1/accounts/verify_credentials", {
      headers: await authHeaders(email),
    });
    const accountId = read(z.object({ id: z.string().min(1) }), credentials.body).id;
    const stored = await insertScheduledStatus(env.DB, {
      accountId,
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      params: {
        text: "scheduled with media",
        visibility: "public",
        spoiler_text: "",
        sensitive: false,
        language: null,
        media_ids: [media],
        media_attributes: [{ id: media, description: "scheduled alt" }],
        poll: null,
        in_reply_to_id: null,
      },
    });
    expect(stored.isOk()).toBe(true);

    expect(await processOutboxJob(env, { kind: "PublishScheduledStatuses" })).toBe("ok");

    const statuses = await json(`/api/v1/accounts/${accountId}/statuses`, {
      headers: await authHeaders(email),
    });
    const [published] = read(z.array(PostedStatus), statuses.body);
    const url = published?.media_attachments[0]?.url;
    expect(url).toMatch(/^https?:\/\//);
    const [created] = await queuedNotes(accountId, "Create");
    expect(created?.attachment).toEqual([
      {
        type: "Document",
        mediaType: "image/png",
        url,
        name: "scheduled alt",
        blurhash: expect.any(String),
        width: 40,
        height: 30,
      },
    ]);
  });

  it("sends no Update when the note's media cannot be read", async () => {
    const email = "note-attachments-update-d1@example.com";
    const media = await upload(email, "kept.png", "image/png");
    const posted = await send(email, "POST", "/api/v1/statuses", {
      status: "media that must survive",
      media_ids: [media],
    });
    expect(posted.status).toBe(200);
    const status = read(PostedStatus, posted.body);
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    const account = (await findAccountById(env.DB, status.account.id))._unsafeUnwrap();
    const note = (await findStatusById(env.DB, status.id))._unsafeUnwrap();
    if (!account || note?.kind !== "LocalNote") {
      throw new Error("posted note not stored");
    }

    await announceNoteUpdate(
      { ...env, DB: failingMediaLookup(env.DB) },
      identity,
      account,
      note,
      new Date().toISOString(),
      true,
    );

    expect(await queuedNotes(status.account.id, "Update")).toEqual([]);
  });

  it("keeps a due scheduled post for the next run while its media cannot be read", async () => {
    const email = "note-attachments-create-d1@example.com";
    const media = await upload(email, "pending.png", "image/png");
    const accountId = await accountIdOf(email);
    const stored = await insertScheduledStatus(env.DB, {
      accountId,
      scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      params: {
        text: "scheduled while D1 fails",
        visibility: "public",
        spoiler_text: "",
        sensitive: false,
        language: null,
        media_ids: [media],
        media_attributes: [],
        poll: null,
        in_reply_to_id: null,
      },
    });
    expect(stored.isOk()).toBe(true);

    await processOutboxJob(
      { ...env, DB: failingMediaLookup(env.DB) },
      { kind: "PublishScheduledStatuses" },
    );
    const statusesPath = `/api/v1/accounts/${accountId}/statuses`;
    const before = await json(statusesPath, { headers: await authHeaders(email) });
    expect(read(z.array(PostedStatus), before.body)).toEqual([]);

    await processOutboxJob(env, { kind: "PublishScheduledStatuses" });

    const after = await json(statusesPath, { headers: await authHeaders(email) });
    const [published] = read(z.array(PostedStatus), after.body);
    expect(published?.media_attachments.map((attachment) => attachment.id)).toEqual([media]);
    const [created] = await queuedNotes(accountId, "Create");
    expect(created?.id).toBe(published?.uri);
  });

  it("answers 500 for a fetched note whose media cannot be read", async () => {
    const email = "note-attachments-fetch-d1@example.com";
    const media = await upload(email, "fetched.png", "image/png");
    const posted = await send(email, "POST", "/api/v1/statuses", {
      status: "fetched while D1 fails",
      media_ids: [media],
    });
    expect(posted.status).toBe(200);
    const status = read(PostedStatus, posted.body);
    const app = new Hono<{ Bindings: Env }>().get(
      "/users/:username/statuses/:id",
      getUsersByUsernameStatusesById,
    );

    const response = await app.request(
      `https://example.com/users/${status.account.username}/statuses/${status.id}`,
      { headers: { accept: "application/activity+json" } },
      { ...env, DB: failingMediaLookup(env.DB) },
    );

    expect(response.status).toBe(500);
  });

  it("marks a sensitized author's media sensitive, as Mastodon does", async () => {
    const email = "note-attachments-sensitized@example.com";
    const accountId = await accountIdOf(email);
    const sensitized = await json(`/api/v1/admin/accounts/${accountId}/sensitize`, {
      method: "POST",
      headers: await authHeaders("note-attachments-admin@example.com", { admin: true }),
    });
    expect(sensitized.status).toBe(200);
    const media = await upload(email, "flagged.png", "image/png");

    await send(email, "POST", "/api/v1/statuses", { status: "with media", media_ids: [media] });
    await send(email, "POST", "/api/v1/statuses", { status: "words only" });

    const created = await queuedNotes(accountId, "Create");
    expect(created.map((note) => note["sensitive"])).toEqual([true, false]);
  });
});
