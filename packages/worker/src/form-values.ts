import { z } from "zod";
export const booleanish = z.union([z.boolean(), z.string(), z.number()]).optional();

export const isTruthy = (value: boolean | string | number | undefined): boolean =>
  value === true || value === "true" || value === "1" || value === 1;

export const stringList = (value: ReadonlyArray<string> | string | undefined): string[] => {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : value.slice();
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
};

export const numberList = (value: ReadonlyArray<number | string> | number | string): number[] => {
  const items = Array.isArray(value) ? value : [value];
  const out: number[] = [];
  for (const item of items) {
    const n = typeof item === "number" ? item : Number.parseInt(item, 10);
    if (Number.isInteger(n)) {
      out.push(n);
    }
  }
  return out;
};
