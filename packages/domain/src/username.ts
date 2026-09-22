import { err, type Result } from "neverthrow";
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { AccessEmail, type AccessEmail as AccessEmailValue } from "./access-email";

export const UsernameBrand = Symbol("Username");

const schema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/)
  .brand<typeof UsernameBrand>();

export type Username = z.infer<typeof schema>;

export type UsernameError = Readonly<{ kind: "Blank" }> | Readonly<{ kind: "InvalidCharacters" }>;

export const Username = {
  schema,
  parse: (raw: unknown): Result<Username, UsernameError> => {
    if (typeof raw !== "string" || raw.trim() === "") {
      return err({ kind: "Blank" });
    }
    const parsed = schemaResult(schema)(raw);
    return parsed.mapErr((): UsernameError => ({ kind: "InvalidCharacters" }));
  },
  deriveFromEmail: (
    email: AccessEmailValue,
    baseUsernameTaken: boolean,
  ): Result<Username, UsernameError> => {
    const local = AccessEmail.localPart(email)
      .split("")
      .map((ch) => {
        const lower = ch.toLowerCase();
        return lower === "-" ? "_" : lower;
      })
      .filter((ch) => /[a-z0-9_]/.test(ch))
      .join("");
    const sanitized = local.length === 0 ? "user" : local;
    const candidate = baseUsernameTaken
      ? `${sanitized}_${AccessEmail.shortSuffix(email)}`
      : sanitized;
    return Username.parse(candidate);
  },
} as const;
