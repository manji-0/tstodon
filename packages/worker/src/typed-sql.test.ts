import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { queryTyped } from "./typed-sql";

const NumberedRow = z.object({ label: z.string(), n: z.number() });

describe("queryTyped", () => {
  it("returns the rows its schema reads and leaves out the ones it does not", async () => {
    const rows = await queryTyped(
      env.DB,
      {
        sql: "SELECT 'one' AS label, 1 AS n UNION ALL SELECT 'two', 'not a number' UNION ALL SELECT $1, $2",
        values: ["three", 3],
      },
      NumberedRow,
    );
    expect(rows).toEqual([
      { label: "one", n: 1 },
      { label: "three", n: 3 },
    ]);
  });

  it("hands back what the schema outputs, not the raw column", async () => {
    const rows = await queryTyped(
      env.DB,
      { sql: "SELECT 1 AS locked", values: [] },
      z.object({ locked: z.number().transform((value) => value === 1) }),
    );
    expect(rows).toEqual([{ locked: true }]);
  });
});
