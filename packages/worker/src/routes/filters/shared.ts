import type { Context } from "hono";
import { z } from "zod";
import { parseJsonColumn } from "../../json-column";
import type { FilterRow } from "../../filter-store";

export const expiresAtFromBody = (raw: number | string | undefined): string | null => {
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
};

export const filterNotFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

export const storedContexts = (row: Pick<FilterRow, "context_json">): string[] =>
  parseJsonColumn(z.array(z.string()), row.context_json).unwrapOr([]);
