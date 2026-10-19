import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

const FilterSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  context: z.array(z.string()),
  expires_at: z.string().nullable(),
  filter_action: z.string(),
  keywords: z.array(
    z.object({ id: z.string().min(1), keyword: z.string().min(1), whole_word: z.boolean() }),
  ),
});

const KeywordSchema = z.object({
  id: z.string().min(1),
  keyword: z.string().min(1),
  whole_word: z.boolean(),
});

const send = async (
  email: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(await auth(email)),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("v2 filters", () => {
  it("creates, reads, updates, and deletes a filter with keywords", async () => {
    const email = "filter-v2-owner@example.com";
    const created = await send(email, "POST", "/api/v2/filters", {
      title: "spoilers",
      context: ["home"],
      filter_action: "hide",
      keywords_attributes: [{ keyword: "endgame" }, { keyword: "finale", whole_word: true }],
    });
    expect(created.status).toBe(200);
    const filter = read(FilterSchema, created.body);
    expect(filter.title).toBe("spoilers");
    expect(filter.filter_action).toBe("hide");
    expect(filter.keywords.map((keyword) => keyword.keyword)).toEqual(["endgame", "finale"]);
    expect(filter.keywords[1]?.whole_word).toBe(true);

    const fetched = await send(email, "GET", `/api/v2/filters/${filter.id}`);
    expect(read(FilterSchema, fetched.body).keywords).toHaveLength(2);

    const updated = await send(email, "PUT", `/api/v2/filters/${filter.id}`, {
      title: "spoilers v2",
      filter_action: "warn",
      expires_in: 3600,
    });
    expect(updated.status).toBe(200);
    const edited = read(FilterSchema, updated.body);
    expect(edited.title).toBe("spoilers v2");
    expect(edited.filter_action).toBe("warn");
    expect(edited.expires_at).not.toBeNull();
    // Keywords survive an update that does not touch them.
    expect(edited.keywords.map((keyword) => keyword.keyword)).toEqual(["endgame", "finale"]);

    // A v1 read still sees the first keyword as the phrase.
    const v1 = await send(email, "GET", "/api/v1/filters");
    expect(
      read(z.array(z.object({ id: z.string(), phrase: z.string() })), v1.body)[0]?.phrase,
    ).toBe("spoilers v2");

    expect((await send(email, "DELETE", `/api/v2/filters/${filter.id}`)).status).toBe(200);
    expect((await send(email, "GET", `/api/v2/filters/${filter.id}`)).status).toBe(404);
  });

  it("manages keywords through the sub-resource", async () => {
    const email = "filter-v2-keywords@example.com";
    const created = await send(email, "POST", "/api/v2/filters", {
      title: "words",
      keywords: ["alpha"],
    });
    const filter = read(FilterSchema, created.body);
    expect(filter.keywords).toHaveLength(1);

    const added = await send(email, "POST", `/api/v2/filters/${filter.id}/keywords`, {
      keyword: "beta",
      whole_word: true,
    });
    expect(added.status).toBe(200);
    const beta = read(KeywordSchema, added.body);
    expect(beta.keyword).toBe("beta");

    const duplicate = await send(email, "POST", `/api/v2/filters/${filter.id}/keywords`, {
      keyword: "BETA",
    });
    expect(duplicate.status).toBe(422);

    const listed = await send(email, "GET", `/api/v2/filters/${filter.id}/keywords`);
    expect(read(z.array(KeywordSchema), listed.body).map((entry) => entry.keyword)).toEqual([
      "alpha",
      "beta",
    ]);

    const renamed = await send(email, "PUT", `/api/v2/filters/${filter.id}/keywords/${beta.id}`, {
      keyword: "gamma",
    });
    expect(renamed.status).toBe(200);
    expect(read(KeywordSchema, renamed.body).keyword).toBe("gamma");
    expect(
      (await send(email, "PUT", `/api/v2/filters/${filter.id}/keywords/unknown`, { keyword: "x" }))
        .status,
    ).toBe(404);

    expect(
      (await send(email, "DELETE", `/api/v2/filters/${filter.id}/keywords/${beta.id}`)).status,
    ).toBe(200);
    const remaining = await send(email, "GET", `/api/v2/filters/${filter.id}/keywords`);
    expect(read(z.array(KeywordSchema), remaining.body).map((entry) => entry.keyword)).toEqual([
      "alpha",
    ]);

    // The last keyword cannot be removed.
    const last = read(z.array(KeywordSchema), remaining.body)[0];
    expect(
      (await send(email, "DELETE", `/api/v2/filters/${filter.id}/keywords/${last?.id ?? ""}`))
        .status,
    ).toBe(422);
  });

  it("requires auth and hides other accounts' filters", async () => {
    const email = "filter-v2-private@example.com";
    const created = await send(email, "POST", "/api/v2/filters", {
      title: "mine",
      keywords: ["secret"],
    });
    const filter = read(FilterSchema, created.body);

    expect((await json("/api/v2/filters")).status).toBe(401);
    expect(
      (await send("filter-v2-other@example.com", "GET", `/api/v2/filters/${filter.id}`)).status,
    ).toBe(404);
    expect(
      (await send("filter-v2-other@example.com", "DELETE", `/api/v2/filters/${filter.id}`)).status,
    ).toBe(404);
  });
});
