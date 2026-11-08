import type { Context } from "hono";

export const parseBool = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true" || value === "1") {
      return true;
    }
    if (value === "false" || value === "0") {
      return false;
    }
  }
  return fallback;
};

export const validation = (c: Context<{ Bindings: Env }>, message: string): Response =>
  c.json({ error: message, kind: "ValidationError" }, 422);
