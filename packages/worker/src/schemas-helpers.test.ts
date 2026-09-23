import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isTruthy,
  numberList,
  parseJsonColumn,
  parseJsonText,
  stringList,
  toRepositoryError,
} from "./schemas";

describe("schemas helpers", () => {
  it("isTruthy accepts boolean/string/number forms", () => {
    expect(isTruthy(true)).toBe(true);
    expect(isTruthy("true")).toBe(true);
    expect(isTruthy("1")).toBe(true);
    expect(isTruthy(1)).toBe(true);
    expect(isTruthy(false)).toBe(false);
    expect(isTruthy("false")).toBe(false);
    expect(isTruthy(0)).toBe(false);
    expect(isTruthy(undefined)).toBe(false);
  });

  it("stringList normalizes arrays and scalars", () => {
    expect(stringList(["a", "b"])).toEqual(["a", "b"]);
    expect(stringList([])).toEqual([]);
    expect(stringList("solo")).toEqual(["solo"]);
    expect(stringList("")).toEqual([]);
    expect(stringList(undefined)).toEqual([]);
  });

  it("numberList coerces integers and drops non-integers", () => {
    expect(numberList([1, "2", "x", 3.5])).toEqual([1, 2]);
    expect(numberList("7")).toEqual([7]);
    expect(numberList(9)).toEqual([9]);
  });

  it("parseJsonText and parseJsonColumn map invalid input to RepositoryError", () => {
    expect(parseJsonText('{"ok":true}').isOk()).toBe(true);
    const bad = parseJsonText("{");
    expect(bad.isErr()).toBe(true);
    if (bad.isErr()) {
      expect(bad.error).toEqual(toRepositoryError("invalid json"));
    }
    const column = parseJsonColumn(z.object({ n: z.number() }), '{"n":1}');
    expect(column.isOk()).toBe(true);
    const invalidColumn = parseJsonColumn(z.object({ n: z.number() }), '{"n":"x"}');
    expect(invalidColumn.isErr()).toBe(true);
    if (invalidColumn.isErr()) {
      expect(invalidColumn.error.kind).toBe("RepositoryError");
    }
  });
});
