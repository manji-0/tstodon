import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import findRemoteThreadResolveExhausted from "../../../prisma/sql/findRemoteThreadResolveExhausted.sql?raw";

const PlanRow = z.object({ detail: z.string() });

describe("the exhausted thread chain lookup's plan", () => {
  it("seeks the reply by its object URI", async () => {
    const { results } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN ${findRemoteThreadResolveExhausted.replace(/\$(\d+)/g, "?$1")}`,
    )
      .bind("https://remote.example/notes/1", "9999-12-31T23:59:59.999Z")
      .all();

    expect(
      z
        .array(PlanRow)
        .parse(results)
        .map((row) => row.detail),
    ).toEqual([
      expect.stringMatching(/^SEARCH remote_statuses USING INDEX \S+ \(object_uri=\?\)$/),
    ]);
  });
});
