import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { PNG_40X30 } from "../test/image-fixtures";

// Mastodon's `UpdateStatusService`: `PUT /api/v1/statuses/:id` carries the
// whole revision, so a field the request leaves out is emptied.

const Revision = z.object({
  id: z.string(),
  content: z.string(),
  spoiler_text: z.string(),
  sensitive: z.boolean(),
  language: z.string().nullable(),
  visibility: z.string(),
  account: z.object({ id: z.string() }),
  media_attachments: z.array(z.object({ id: z.string() })),
  poll: z
    .object({
      id: z.string(),
      multiple: z.boolean(),
      votes_count: z.number(),
      voters_count: z.number().nullable(),
      expires_at: z.string().nullable(),
      options: z.array(z.object({ title: z.string(), votes_count: z.number().nullable() })),
    })
    .nullable(),
});
type Revision = z.infer<typeof Revision>;

const send = async (
  email: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> =>
  SELF.fetch(`https://example.com${path}`, {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const create = async (email: string, body: Record<string, unknown>): Promise<Revision> => {
  const response = await send(email, "POST", "/api/v1/statuses", body);
  expect(response.status).toBe(200);
  return Revision.parse(await response.json());
};

const edit = async (
  email: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Revision> => {
  const response = await send(email, "PUT", `/api/v1/statuses/${id}`, body);
  expect(response.status).toBe(200);
  return Revision.parse(await response.json());
};

const upload = async (email: string): Promise<string> => {
  const form = new FormData();
  form.set("file", new File([PNG_40X30], "a.png", { type: "image/png" }));
  const response = await SELF.fetch("https://example.com/api/v2/media", {
    method: "POST",
    headers: await authHeaders(email),
    body: form,
  });
  expect(response.status).toBe(200);
  return z.object({ id: z.string() }).parse(await response.json()).id;
};

const vote = async (email: string, pollId: string, choices: number[]): Promise<void> => {
  const response = await send(email, "POST", `/api/v1/polls/${pollId}/votes`, { choices });
  expect(response.status).toBe(200);
};

const UpdateActivity = z.object({
  type: z.literal("Update"),
  object: z.looseObject({ type: z.string(), sensitive: z.boolean() }),
});

/** The object of the last `Update` queued for the author's followers. */
const lastUpdateObject = async (authorId: string) => {
  const row = await env.DB.prepare(
    "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Update' ORDER BY rowid DESC LIMIT 1",
  )
    .bind(authorId)
    .first();
  const payload = z.object({ payload_json: z.string() }).parse(row).payload_json;
  return UpdateActivity.parse(JSON.parse(payload)).object;
};

describe("an edit replaces the whole revision", () => {
  it("empties the content warning, the sensitive flag and the media the request leaves out", async () => {
    const email = "rev-author@example.com";
    const mediaId = await upload(email);
    const original = await create(email, {
      status: "first",
      spoiler_text: "warning",
      sensitive: true,
      language: "ja",
      visibility: "unlisted",
      media_ids: [mediaId],
    });
    expect(original.media_attachments).toHaveLength(1);

    const edited = await edit(email, original.id, { status: "second" });
    expect(edited).toMatchObject({
      spoiler_text: "",
      sensitive: false,
      media_attachments: [],
      // Mastodon keeps the language of a revision that names none.
      language: "ja",
      visibility: "unlisted",
    });

    const history = await send(email, "GET", `/api/v1/statuses/${original.id}/history`);
    expect(await history.json()).toMatchObject([
      { spoiler_text: "warning", sensitive: true, media_attachments: [{ id: mediaId }] },
      { spoiler_text: "", sensitive: false, media_attachments: [] },
    ]);

    const federated = await lastUpdateObject(original.account.id);
    expect(federated).toMatchObject({ type: "Note", sensitive: false });
    expect(federated.summary ?? null).toBeNull();
    expect(federated.attachment ?? []).toEqual([]);
  });

  it("marks a revision with a content warning sensitive", async () => {
    const email = "rev-cw@example.com";
    const original = await create(email, { status: "first" });
    const edited = await edit(email, original.id, { status: "second", spoiler_text: "warning" });
    expect(edited).toMatchObject({ spoiler_text: "warning", sensitive: true });
  });

  it("keeps the visibility, which an edit cannot change", async () => {
    const email = "rev-visibility@example.com";
    const original = await create(email, { status: "first", visibility: "unlisted" });
    const edited = await edit(email, original.id, { status: "second", visibility: "public" });
    expect(edited.visibility).toBe("unlisted");
  });

  it("removes the poll the request leaves out", async () => {
    const email = "rev-poll-gone@example.com";
    const original = await create(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    expect(original.poll).not.toBeNull();
    await vote("rev-poll-gone-voter@example.com", original.poll?.id ?? "", [0]);

    const edited = await edit(email, original.id, { status: "no poll" });
    expect(edited.poll).toBeNull();
    const gone = await send(email, "GET", `/api/v1/polls/${original.poll?.id ?? ""}`);
    expect(gone.status).toBe(404);

    const history = await send(email, "GET", `/api/v1/statuses/${original.id}/history`);
    expect(await history.json()).toMatchObject([
      { poll: { options: [{ title: "yes" }, { title: "no" }] } },
      { poll: null },
    ]);
    expect((await lastUpdateObject(original.account.id)).type).toBe("Note");
  });

  it("adds the poll the request brings", async () => {
    const email = "rev-poll-new@example.com";
    const original = await create(email, { status: "plain" });
    const edited = await edit(email, original.id, {
      status: "now a poll",
      poll: { options: ["yes", "no"], expires_in: 3600, multiple: true },
    });
    expect(edited.poll).toMatchObject({
      multiple: true,
      votes_count: 0,
      options: [{ title: "yes" }, { title: "no" }],
    });
    expect((await lastUpdateObject(original.account.id)).type).toBe("Question");
  });

  it("keeps the votes of a poll whose options the revision repeats", async () => {
    const email = "rev-poll-kept@example.com";
    const original = await create(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    await vote("rev-poll-kept-voter@example.com", original.poll?.id ?? "", [1]);

    const edited = await edit(email, original.id, {
      status: "poll, reworded",
      poll: { options: ["yes", "no"], expires_in: 7200, multiple: false },
    });
    expect(edited.poll).toMatchObject({
      id: original.poll?.id,
      votes_count: 1,
      voters_count: 1,
      options: [{ votes_count: 0 }, { votes_count: 1 }],
    });
    // The expiry starts again from the edit, as Mastodon's `expires_in=`.
    expect(Date.parse(edited.poll?.expires_at ?? "")).toBeGreaterThan(
      Date.parse(original.poll?.expires_at ?? "") + 3000 * 1000,
    );
  });

  it("resets the votes of a poll whose options the revision changes", async () => {
    const email = "rev-poll-reset@example.com";
    const voter = "rev-poll-reset-voter@example.com";
    const original = await create(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    await vote(voter, original.poll?.id ?? "", [0]);

    const edited = await edit(email, original.id, {
      status: "poll",
      poll: { options: ["yes", "no", "maybe"], expires_in: 3600 },
    });
    expect(edited.poll).toMatchObject({
      id: original.poll?.id,
      votes_count: 0,
      voters_count: 0,
      options: [{ votes_count: 0 }, { votes_count: 0 }, { votes_count: 0 }],
    });
    // The voter's earlier vote is gone, so the poll takes a new one.
    await vote(voter, original.poll?.id ?? "", [2]);
  });

  it("resets the votes of a poll whose revision leaves `multiple` out or pads an option", async () => {
    const email = "rev-poll-cast@example.com";
    const original = await create(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    const pollId = original.poll?.id ?? "";
    await vote("rev-poll-cast-voter@example.com", pollId, [0]);
    // Mastodon casts a missing `multiple` to `nil`, which is not the stored `false`.
    const unflagged = await edit(email, original.id, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    expect(unflagged.poll).toMatchObject({ id: pollId, votes_count: 0, multiple: false });

    await vote("rev-poll-cast-voter@example.com", pollId, [0]);
    // It compares the options as sent, before `Poll` strips them.
    const padded = await edit(email, original.id, {
      status: "poll",
      poll: { options: ["yes ", "no"], expires_in: 3600, multiple: false },
    });
    expect(padded.poll).toMatchObject({
      votes_count: 0,
      options: [
        { title: "yes", votes_count: 0 },
        { title: "no", votes_count: 0 },
      ],
    });
  });

  it("refuses a poll without `expires_in`, which Mastodon sets on every edit", async () => {
    const email = "rev-poll-no-end@example.com";
    const original = await create(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    for (const target of [original, await create(email, { status: "no poll yet" })]) {
      const response = await send(email, "PUT", `/api/v1/statuses/${target.id}`, {
        status: "poll",
        poll: { options: ["yes", "no"], multiple: false },
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: "Validation failed: Deadline can't be blank",
      });
    }
    const fetched = await send(email, "GET", `/api/v1/statuses/${original.id}`);
    expect(Revision.parse(await fetched.json()).poll?.expires_at).toBe(original.poll?.expires_at);
  });

  it("takes the revision Mastodon's web client sends for a post whose poll has votes", async () => {
    const email = "rev-web-client@example.com";
    const original = await create(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 3600 },
    });
    await vote("rev-web-client-voter@example.com", original.poll?.id ?? "", [0]);

    // `submitCompose` (`src/mastodon/actions/compose.ts`), field for field.
    const edited = await edit(email, original.id, {
      status: "poll, typo fixed",
      spoiler_text: "",
      in_reply_to_id: null,
      media_ids: [],
      media_attributes: [],
      sensitive: false,
      visibility: "public",
      poll: { options: ["yes", "no"], expires_in: 86400, multiple: false },
      language: "en",
      quoted_status_id: null,
      quote_approval_policy: "public",
    });
    expect(edited.content).toContain("poll, typo fixed");
    expect(edited.poll).toMatchObject({ votes_count: 1, options: [{ votes_count: 1 }, {}] });
  });

  it("turns the content warning of a revision without text into its text", async () => {
    const email = "rev-cw-only@example.com";
    const original = await create(email, { status: "first", spoiler_text: "old warning" });
    const edited = await edit(email, original.id, { status: "", spoiler_text: "only this" });
    expect(edited.content).toContain("only this");
    // `UpdateStatusService` takes the warning out of the request, so the stored one stays.
    expect(edited).toMatchObject({ spoiler_text: "old warning", sensitive: false });
  });
});
