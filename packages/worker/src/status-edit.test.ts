import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { schemaResult } from "@tstodon/core";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

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
        visibility: "unlisted",
      }),
    });
    expect(edited.status).toBe(200);
    const editedDoc = read(EditedStatusSchema, edited.body);
    expect(editedDoc.id).toBe(original.id);
    expect(editedDoc.created_at).toBe(original.created_at);
    expect(editedDoc.content).toContain("edited text");
    expect(editedDoc.spoiler_text).toBe("cw");
    expect(editedDoc.sensitive).toBe(true);
    expect(editedDoc.visibility).toBe("unlisted");
    expect(editedDoc.edited_at).not.toBeNull();

    const history = await json(`/api/v1/statuses/${original.id}/history`);
    expect(history.status).toBe(200);
    const entries = read(
      z.array(z.object({ id: z.string(), content: z.string(), created_at: z.string() })),
      history.body,
    );
    expect(entries.length).toBe(2);
    expect(entries[0]?.content).toContain("original text");
    expect(entries[entries.length - 1]?.content).toContain("edited text");
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
    expect(
      read(z.object({ id: z.string(), text: z.string(), spoiler_text: z.string() }), source.body),
    ).toEqual({ id: status.id, text: "raw text #tag", spoiler_text: "cw" });
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

  it("rejects editing a poll", async () => {
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
      body: JSON.stringify({ status: "polled", poll: { options: ["a", "b"] } }),
    });
    expect(edited.status).toBe(422);
  });
});
