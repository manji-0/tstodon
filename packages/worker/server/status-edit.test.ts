import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus, ApiStatusEdit, ApiStatusSource } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { schemaResult } from "@tstodon/core";
import { newEntityId } from "./ids";
import { newAttachmentObjectKey } from "./media-keys";
import { insertMedia } from "./media-store";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

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

const EditedStatusSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  spoiler_text: z.string(),
  sensitive: z.boolean(),
  visibility: z.string(),
  created_at: z.string(),
  edited_at: z.string().nullable(),
});

const jsonBody = (payload: unknown, email: string) => async (): Promise<RequestInit> => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(await auth(email)) },
  body: JSON.stringify(payload),
});

describe("status editing", () => {
  it("edits a status, keeps its id, and records history", async () => {
    const email = "edit-author@example.com";
    const created = await json(
      "/api/v1/statuses",
      await jsonBody({ status: "original text" }, email)(),
    );
    expect(created.status).toBe(200);
    const original = read(EditedStatusSchema, created.body);
    expect(original.edited_at).toBeNull();

    const edited = await json(`/api/v1/statuses/${original.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({
        status: "edited text",
        spoiler_text: "cw",
        sensitive: true,
      }),
    });
    expect(edited.status).toBe(200);
    const editedDoc = read(EditedStatusSchema, edited.body);
    expect(editedDoc.id).toBe(original.id);
    expect(editedDoc.created_at).toBe(original.created_at);
    expect(editedDoc.content).toContain("edited text");
    expect(editedDoc.spoiler_text).toBe("cw");
    expect(editedDoc.sensitive).toBe(true);
    expect(editedDoc.edited_at).not.toBeNull();

    const history = await json(`/api/v1/statuses/${original.id}/history`);
    expect(history.status).toBe(200);
    // `StatusEdit` entities, not statuses: no id, the revision's own fields.
    const entries = expectContract(z.array(ApiStatusEdit), history.body);
    expect(history.body).toEqual([
      expect.not.objectContaining({ id: expect.anything() }),
      expect.not.objectContaining({ id: expect.anything() }),
    ]);
    expect(entries).toMatchObject([
      {
        spoiler_text: "",
        sensitive: false,
        created_at: original.created_at,
        poll: null,
        account: { username: "edit_author" },
      },
      {
        spoiler_text: "cw",
        sensitive: true,
        created_at: editedDoc.edited_at,
        account: { username: "edit_author" },
      },
    ]);
    expect(entries[0]?.content).toContain("original text");
    expect(entries[1]?.content).toContain("edited text");
  });

  it("reads a revision stored as a whole status document", async () => {
    const email = "edit-legacy@example.com";
    const created = await json("/api/v1/statuses", await jsonBody({ status: "first" }, email)());
    const original = expectContract(ApiStatus, created.body);
    const edited = await json(`/api/v1/statuses/${original.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ status: "second" }),
    });
    expect(edited.status).toBe(200);
    // Snapshots written before `StatusEditSnapshot` held the Status document.
    await env.DB.prepare(`UPDATE status_edits SET snapshot_json = ? WHERE status_id = ?`)
      .bind(JSON.stringify({ ...original, content: "<p>legacy</p>" }), original.id)
      .run();

    const history = await json(`/api/v1/statuses/${original.id}/history`);
    const entries = expectContract(z.array(ApiStatusEdit), history.body);
    expect(entries.map((entry) => entry.content)).toEqual([
      "<p>legacy</p>",
      expect.stringContaining("second"),
    ]);
    expect(entries[0]).not.toHaveProperty("id");
  });

  it("serves the raw source", async () => {
    const email = "edit-source@example.com";
    const created = await json(
      "/api/v1/statuses",
      await jsonBody({ status: "raw text #tag", spoiler_text: "cw" }, email)(),
    );
    const status = read(EditedStatusSchema, created.body);

    const source = await json(`/api/v1/statuses/${status.id}/source`, {
      headers: await auth(email),
    });
    expect(source.status).toBe(200);
    expect(expectContract(ApiStatusSource, source.body)).toEqual({
      id: status.id,
      text: "raw text #tag",
      spoiler_text: "cw",
    });
  });

  it("404s for a status the viewer does not own", async () => {
    const created = await json(
      "/api/v1/statuses",
      await jsonBody({ status: "owned by edit-owner" }, "edit-owner@example.com")(),
    );
    const status = read(EditedStatusSchema, created.body);

    const denied = await json(`/api/v1/statuses/${status.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth("edit-stranger@example.com")) },
      body: JSON.stringify({ status: "hijack" }),
    });
    expect(denied.status).toBe(404);
  });

  it("edits a poll in place", async () => {
    const email = "edit-poll@example.com";
    const created = await json(
      "/api/v1/statuses",
      await jsonBody(
        { status: "poll status", poll: { options: ["yes", "no"], expires_in: 3600 } },
        email,
      )(),
    );
    const status = read(EditedStatusSchema, created.body);

    const edited = await json(`/api/v1/statuses/${status.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({
        status: "poll status v2",
        poll: { options: ["alpha", "beta", "gamma"], expires_in: 7200, multiple: true },
      }),
    });
    expect(edited.status).toBe(200);
    const poll = read(
      z.object({
        poll: z
          .object({
            options: z.array(z.object({ title: z.string() })),
            multiple: z.boolean(),
          })
          .nullable(),
      }),
      edited.body,
    );
    expect(poll.poll?.options.map((option) => option.title)).toEqual(["alpha", "beta", "gamma"]);
    expect(poll.poll?.multiple).toBe(true);
  });

  it("requires at least two poll options", async () => {
    const email = "edit-poll-short@example.com";
    const created = await json(
      "/api/v1/statuses",
      await jsonBody(
        { status: "short poll", poll: { options: ["one", "two"], expires_in: 3600 } },
        email,
      )(),
    );
    const status = read(EditedStatusSchema, created.body);
    const edited = await json(`/api/v1/statuses/${status.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify({ poll: { options: ["only"] } }),
    });
    expect(edited.status).toBe(422);
  });
});

/** As Mastodon's `UpdateStatusService`, an edit that changes nothing is no edit (`NoChangesSubmittedError`). */
describe("an edit that changes nothing", () => {
  const CountRow = z.object({ count: z.number() });

  const storedRevisions = async (statusId: string): Promise<number> =>
    read(
      CountRow,
      await env.DB.prepare("SELECT COUNT(*) AS count FROM status_edits WHERE status_id = ?")
        .bind(statusId)
        .first(),
    ).count;

  const sentUpdates = async (statusId: string): Promise<number> =>
    read(
      CountRow,
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM outbound_activities WHERE kind = 'Update' AND payload_json LIKE ?",
      )
        .bind(`%/statuses/${statusId}%`)
        .first(),
    ).count;

  const accountIdOf = async (email: string): Promise<string> =>
    read(
      z.object({ id: z.string().min(1) }),
      (await json("/api/v1/accounts/verify_credentials", { headers: await auth(email) })).body,
    ).id;

  const seedMedia = async (email: string): Promise<string> => {
    const accountId = await accountIdOf(email);
    const id = newEntityId();
    const objectKey = newAttachmentObjectKey(accountId);
    await env.MEDIA.put(objectKey, new Uint8Array([1, 2, 3]));
    const inserted = await insertMedia(env.DB, {
      id,
      accountId,
      objectKey,
      fileSize: 3,
      contentType: "image/png",
      description: null,
      focus: null,
      image: { original: { width: 40, height: 30 }, preview: undefined, blurhash: null },
    });
    expect(inserted.isOk()).toBe(true);
    return id;
  };

  const create = async (email: string, payload: unknown) =>
    expectContract(
      ApiStatus,
      (await json("/api/v1/statuses", await jsonBody(payload, email)())).body,
    );

  const edit = async (email: string, id: string, payload: unknown) =>
    json(`/api/v1/statuses/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(await auth(email)) },
      body: JSON.stringify(payload),
    });

  it("answers the status as it is, with no revision and no Update", async () => {
    const email = "edit-noop@example.com";
    const status = await create(email, { status: "same words", spoiler_text: "cw" });

    const edited = await edit(email, status.id, {
      status: "same words",
      spoiler_text: "cw",
      sensitive: true,
    });

    expect(edited.status).toBe(200);
    expect(expectContract(ApiStatus, edited.body)).toMatchObject({
      id: status.id,
      content: status.content,
      spoiler_text: "cw",
      sensitive: true,
      edited_at: null,
    });
    expect(await storedRevisions(status.id)).toBe(0);
    expect(await sentUpdates(status.id)).toBe(0);
    const history = await json(`/api/v1/statuses/${status.id}/history`);
    expect(expectContract(z.array(ApiStatusEdit), history.body)).toHaveLength(1);
  });

  it("counts text that differs only in surrounding whitespace as a change", async () => {
    const email = "edit-whitespace@example.com";
    const status = await create(email, { status: "padded" });

    // Mastodon compares the request's text before `prepare_contents` strips it.
    const edited = await edit(email, status.id, { status: "padded " });

    expect(expectContract(ApiStatus, edited.body).edited_at).not.toBeNull();
    expect(await storedRevisions(status.id)).toBe(1);
  });

  it("ignores media sent again with the same description and focus", async () => {
    const email = "edit-noop-media@example.com";
    const first = await seedMedia(email);
    const second = await seedMedia(email);
    const attributes = [
      { id: first, description: "a cat", focus: "0.5,-0.25" },
      { id: second, description: "a dog" },
    ];
    const status = await create(email, {
      status: "pets",
      media_ids: [first, second],
      media_attributes: attributes,
    });

    const same = await edit(email, status.id, {
      status: "pets",
      media_ids: [first, second],
      media_attributes: attributes,
    });
    expect(expectContract(ApiStatus, same.body).edited_at).toBeNull();
    expect(await storedRevisions(status.id)).toBe(0);
    expect(await sentUpdates(status.id)).toBe(0);

    const described = await edit(email, status.id, {
      status: "pets",
      media_ids: [first, second],
      media_attributes: [{ id: second, description: "a wolf" }],
    });
    expect(expectContract(ApiStatus, described.body).edited_at).not.toBeNull();
    expect(await storedRevisions(status.id)).toBe(1);

    const reordered = await edit(email, status.id, { status: "pets", media_ids: [second, first] });
    expect(
      expectContract(ApiStatus, reordered.body).media_attachments.map((media) => media.id),
    ).toEqual([second, first]);
    expect(await storedRevisions(status.id)).toBe(2);
  });

  it("counts a new focus as a change", async () => {
    const email = "edit-focus@example.com";
    const media = await seedMedia(email);
    const status = await create(email, {
      status: "focus",
      media_ids: [media],
      media_attributes: [{ id: media, focus: "0.1,0.1" }],
    });

    const moved = await edit(email, status.id, {
      status: "focus",
      media_ids: [media],
      media_attributes: [{ id: media, focus: "0.2,0.1" }],
    });

    expect(expectContract(ApiStatus, moved.body).edited_at).not.toBeNull();
    expect(await storedRevisions(status.id)).toBe(1);
  });

  it("counts a new quote policy as a change, and the same one as none", async () => {
    const email = "edit-noop-policy@example.com";
    const status = await create(email, { status: "quotable", quote_approval_policy: "public" });

    await edit(email, status.id, { status: "quotable", quote_approval_policy: "public" });
    expect(await storedRevisions(status.id)).toBe(0);

    const tightened = await edit(email, status.id, {
      status: "quotable",
      quote_approval_policy: "followers",
    });
    expect(expectContract(ApiStatus, tightened.body).edited_at).not.toBeNull();
    expect(await storedRevisions(status.id)).toBe(1);
  });

  it("counts a poll sent again as a change, since its end moves", async () => {
    const email = "edit-noop-poll@example.com";
    const poll = { options: ["yes", "no"], expires_in: 3600 };
    const status = await create(email, { status: "vote", poll });

    const resent = await edit(email, status.id, { status: "vote", poll });

    expect(expectContract(ApiStatus, resent.body).edited_at).not.toBeNull();
    expect(await sentUpdates(status.id)).toBe(1);
  });
});
