import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "../test/mastodon-preview-schemas";

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

const RelationshipSchema = z.object({ id: z.string().min(1), note: z.string() });

const accountIdFor = async (email: string): Promise<string> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  expect(response.status).toBe(200);
  return read(MastodonAccountPreviewSchema, response.body).id;
};

const setNote = async (
  email: string,
  targetId: string,
  comment: string,
): Promise<{ status: number; body: unknown }> =>
  json(`/api/v1/accounts/${targetId}/note`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify({ comment }),
  });

describe("account notes", () => {
  it("stores a private note only for its author", async () => {
    const viewer = "note-viewer@example.com";
    const other = "note-other@example.com";
    const targetId = await accountIdFor("note-target@example.com");
    await accountIdFor(viewer);
    await accountIdFor(other);

    const saved = await setNote(viewer, targetId, "met at the conference");
    expect(saved.status).toBe(200);
    expect(read(RelationshipSchema, saved.body).note).toBe("met at the conference");

    const relationships = await json(`/api/v1/accounts/relationships?id[]=${targetId}`, {
      headers: await auth(viewer),
    });
    expect(read(z.array(RelationshipSchema), relationships.body)[0]?.note).toBe(
      "met at the conference",
    );

    const otherView = await json(`/api/v1/accounts/relationships?id[]=${targetId}`, {
      headers: await auth(other),
    });
    expect(read(z.array(RelationshipSchema), otherView.body)[0]?.note).toBe("");
  });

  it("clears the note when the comment is blank", async () => {
    const email = "note-clear@example.com";
    const targetId = await accountIdFor("note-clear-target@example.com");
    await accountIdFor(email);

    await setNote(email, targetId, "temporary");
    const cleared = await setNote(email, targetId, "   ");
    expect(cleared.status).toBe(200);
    expect(read(RelationshipSchema, cleared.body).note).toBe("");
  });

  it("requires authentication and 404s for unknown targets", async () => {
    expect((await json("/api/v1/accounts/whatever/note", { method: "POST" })).status).toBe(401);
    const missing = await setNote("note-missing@example.com", "nope", "hi");
    expect(missing.status).toBe(404);
  });
});
