import { z } from "zod";
export const booleanish = z.union([z.boolean(), z.string(), z.number()]).optional();

export const isTruthy = (value: boolean | string | number | undefined): boolean =>
  value === true || value === "true" || value === "1" || value === 1;

export const stringList = (value: ReadonlyArray<string> | string | undefined): string[] => {
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  return [...value];
};

export const numberList = (value: ReadonlyArray<number | string> | number | string): number[] => {
  const items = typeof value === "number" || typeof value === "string" ? [value] : value;
  return items
    .map((item) => (typeof item === "number" ? item : Number.parseInt(item, 10)))
    .filter((n) => Number.isInteger(n));
};
