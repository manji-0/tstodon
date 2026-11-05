import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
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

const upload = async (email: string, name: string, type: string): Promise<string> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([9, 9, 9])], name, { type }));
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
        blurhash: null,
      },
      {
        type: "Document",
        mediaType: "image/png",
        url: urls.get(photo),
        name: "a described photo",
        blurhash: null,
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
        blurhash: null,
      },
    ];
    const updates = await queuedNotes(status.account.id, "Update");
    expect(updates.at(-1)?.attachment).toEqual(expected);

    const fetched = await json(`/users/${status.account.username}/statuses/${status.id}`);
    expect(fetched.status).toBe(200);
    const note = read(z.looseObject({ attachment: z.unknown().optional() }), fetched.body);
    expect(note.attachment).toEqual(expected);
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
      { type: "Document", mediaType: "image/png", url, name: "scheduled alt", blurhash: null },
    ]);
  });
});
