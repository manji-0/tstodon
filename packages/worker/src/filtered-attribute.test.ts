import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

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

const FilteredSchema = z.array(
  z.object({
    filter: z.object({ id: z.string().min(1), title: z.string() }),
    keyword_matches: z.array(z.string()),
    status_matches: z.array(z.string()),
  }),
);

const post = async (
  email: string,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json(path, {
    method,
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });

const createFilter = async (email: string, body: Record<string, unknown>): Promise<string> => {
  const response = await post(email, "POST", "/api/v2/filters", body);
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

describe("filtered attribute", () => {
  it("marks search results that match the viewer's public filters", async () => {
    const author = "filtered-author@example.com";
    const viewer = "filtered-viewer@example.com";
    const created = await post(author, "POST", "/api/v1/statuses", {
      status: "watching the endgame tonight",
    });
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;

    const before = await json("/api/v2/search?q=endgame", { headers: await auth(viewer) });
    const beforeDocs = read(
      z.object({
        statuses: z.array(z.object({ id: z.string(), filtered: FilteredSchema.optional() })),
      }),
      before.body,
    ).statuses;
    expect(beforeDocs.find((status) => status.id === statusId)?.filtered).toBeUndefined();

    await createFilter(viewer, {
      title: "spoilers",
      context: ["public"],
      keywords: ["endgame"],
    });

    const after = await json("/api/v2/search?q=endgame", { headers: await auth(viewer) });
    const afterDocs = read(
      z.object({
        statuses: z.array(z.object({ id: z.string(), filtered: FilteredSchema.optional() })),
      }),
      after.body,
    ).statuses;
    const matched = afterDocs.find((status) => status.id === statusId)?.filtered;
    expect(matched).toHaveLength(1);
    expect(matched?.[0]?.filter.title).toBe("spoilers");
    expect(matched?.[0]?.keyword_matches).toEqual(["endgame"]);

    // A whole-word filter does not match a substring.
    await createFilter(viewer, {
      title: "whole",
      context: ["public"],
      keywords_attributes: [{ keyword: "end", whole_word: true }],
    });
    const wholeWord = await json("/api/v2/search?q=endgame", { headers: await auth(viewer) });
    const wholeDocs = read(
      z.object({
        statuses: z.array(z.object({ id: z.string(), filtered: FilteredSchema.optional() })),
      }),
      wholeWord.body,
    ).statuses;
    expect(
      wholeDocs
        .find((status) => status.id === statusId)
        ?.filtered?.map((entry) => entry.filter.title),
    ).toEqual(["spoilers"]);
  });

  it("marks a mention notification and honours narrowing", async () => {
    const viewerEmail = "filtered-mention-viewer@example.com";
    const viewer = read(
      z.object({ username: z.string().min(1) }),
      (await json("/api/v1/accounts/verify_credentials", { headers: await auth(viewerEmail) }))
        .body,
    ).username;
    const created = await post("filtered-mentioner@example.com", "POST", "/api/v1/statuses", {
      status: `@${viewer} the finale is wild`,
    });
    const statusId = read(z.object({ id: z.string().min(1) }), created.body).id;

    const filterId = await createFilter(viewerEmail, {
      title: "finale",
      context: ["notifications"],
      keywords_attributes: [{ keyword: "finale", whole_word: true }],
    });

    const notifications = await json("/api/v1/notifications", { headers: await auth(viewerEmail) });
    const rows = read(
      z.array(
        z.object({
          type: z.string(),
          status: z.object({ id: z.string() }).nullable(),
          filtered: FilteredSchema.optional(),
        }),
      ),
      notifications.body,
    );
    const mention = rows.find((row) => row.status?.id === statusId);
    expect(mention?.filtered?.[0]?.filter.title).toBe("finale");

    // Narrowing a filter to this status also matches, even without a keyword hit.
    await createFilter(viewerEmail, {
      title: "narrow",
      context: ["notifications"],
      keywords: ["nomatch"],
    });
    const narrowed = await post(viewerEmail, "POST", "/api/v2/filters", {
      title: "narrow",
      context: ["notifications"],
      keywords: ["nomatch"],
    });
    const narrowId = read(z.object({ id: z.string().min(1) }), narrowed.body).id;
    void narrowId;
    const addStatus = await post(viewerEmail, "POST", `/api/v2/filters/${filterId}/statuses`, {
      status_ids: [statusId],
    });
    expect(addStatus.status).toBe(200);

    const after = await json("/api/v1/notifications", { headers: await auth(viewerEmail) });
    const afterRows = read(
      z.array(
        z.object({
          status: z.object({ id: z.string() }).nullable(),
          filtered: FilteredSchema.optional(),
        }),
      ),
      after.body,
    );
    const narrowedFilter = afterRows
      .find((row) => row.status?.id === statusId)
      ?.filtered?.find((entry) => entry.filter.title === "finale");
    expect(narrowedFilter?.status_matches).toEqual([statusId]);
  });
});
