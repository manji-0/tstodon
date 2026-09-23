import { describe, expect, it } from "vitest";
import { D1_MAX_BOUND_PARAMETERS, jsonStringArray, sqlInJsonEach } from "./d1";

describe("sqlInJsonEach", () => {
  it("uses a single bind for membership regardless of list size", () => {
    const fragment = sqlInJsonEach();
    expect(fragment).toBe("IN (SELECT value FROM json_each(?))");
    expect(fragment.match(/\?/g)?.length).toBe(1);

    // Historical cfwdon trap: trending cache size 200 > D1_MAX_BOUND_PARAMETERS.
    const ids = Array.from({ length: 200 }, (_, i) => `status-${i}`);
    const sql = `WHERE id ${sqlInJsonEach()}`;
    expect(sql.match(/\?/g)?.length).toBe(1);
    expect(ids.length).toBeGreaterThan(D1_MAX_BOUND_PARAMETERS);
    expect(jsonStringArray(ids)).toContain("status-0");
  });

  it("jsonStringArray encodes values as JSON text", () => {
    expect(jsonStringArray(["a", "b"])).toBe('["a","b"]');
    expect(jsonStringArray([])).toBe("[]");
    expect(jsonStringArray(['quote"here'])).toBe('["quote\\"here"]');
  });
});
