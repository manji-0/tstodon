import { err, type Result } from "neverthrow";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";

export const UsernameBrand = Symbol("Username");

const schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/)
  .brand<typeof UsernameBrand>();

export type Username = z.infer<typeof schema>;

export type UsernameError =
  | Readonly<{ kind: "Blank" }>
  | Readonly<{ kind: "InvalidCharacters" }>;

export const Username = {
  schema,
  parse: (raw: unknown): Result<Username, UsernameError> => {
    if (typeof raw !== "string" || raw.trim() === "") {
      return err({ kind: "Blank" });
    }
    const parsed = schemaResult(schema)(raw);
    return parsed.mapErr((): UsernameError => ({ kind: "InvalidCharacters" }));
  },
} as const;
