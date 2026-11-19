import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

/**
 * A note's `quote` read back for its document: a transient D1 error is a
 * failed answer, never a cached document without the quote.
 */

const ORIGIN = "https://example.com";
const AP_ACCEPT = "application/activity+json";

const post = async (email: string, body: Record<string, string>) => {
  const response = await SELF.fetch(new URL("/api/v1/statuses", ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const fetchAs = (path: string) =>
  SELF.fetch(new URL(path, ORIGIN), { headers: { Accept: AP_ACCEPT } });

/** Every D1 read of `status_quotes` that binds `id` fails while `run` runs. */
const failingQuoteReads = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
  const prototype: object = Object.getPrototypeOf(env.DB.prepare("SELECT 1"));
  const originals = new Map(
    ["first", "all", "raw", "run"].map((name) => [name, Reflect.get(prototype, name)]),
  );
  for (const [name, original] of originals) {
    Reflect.set(prototype, name, function (this: object, ...args: unknown[]) {
      const sql: unknown = Reflect.get(this, "statement");
      const params: unknown = Reflect.get(this, "params");
      if (
        typeof sql === "string" &&
        sql.includes("status_quotes") &&
        Array.isArray(params) &&
        params.some((param) => typeof param === "string" && param.includes(id))
      ) {
        return Promise.reject(new Error("D1_ERROR: injected"));
      }
      return Reflect.apply(original, this, args);
    });
  }
  try {
    return await run();
  } finally {
    for (const [name, original] of originals) {
      Reflect.set(prototype, name, original);
    }
  }
};

describe("a local note's quote, when it cannot be read", () => {
  it("fails the note and the outbox page, uncached", async () => {
    await signedInAccount("note-quote-read-quoted@example.com");
    const quoter = await signedInAccount("note-quote-read-quoter@example.com");
    const quoted = await post("note-quote-read-quoted@example.com", { status: "quote me" });
    const quoting = await post("note-quote-read-quoter@example.com", {
      status: "quoting",
      quoted_status_id: quoted.id,
    });
    const notePath = `/users/${quoter.username}/statuses/${quoting.id}`;
    const pagePath = `/users/${quoter.username}/outbox?page=true`;
    const QuoteOf = z.object({ quote: z.string() });
    const note = await fetchAs(notePath);
    expect(note.status).toBe(200);
    expect(QuoteOf.parse(await note.json()).quote).toBe(quoted.uri);

    const [failedNote, failedPage] = await failingQuoteReads(quoting.id, async () => [
      await fetchAs(notePath),
      await fetchAs(pagePath),
    ]);
    for (const response of [failedNote, failedPage]) {
      expect(response.status, response.url).toBe(500);
      expect(response.headers.get("Cache-Control"), response.url).toBeNull();
    }
  });
});
