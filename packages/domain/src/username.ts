import { err, type Result } from "neverthrow";
import { compileSchema, schemaResult } from "@tstodon/core";
import { z } from "zod";
import { AccessEmail, type AccessEmail as AccessEmailValue } from "./access-email";

export const UsernameBrand = Symbol("Username");

const rawSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]+$/)
  .brand<typeof UsernameBrand>();

const schema = compileSchema(rawSchema);

export type Username = z.infer<typeof rawSchema>;

export type UsernameError = Readonly<{ kind: "Blank" }> | Readonly<{ kind: "InvalidCharacters" }>;

const parseUsername = schemaResult(schema);

export const Username = {
  schema,
  parse: (raw: unknown): Result<Username, UsernameError> => {
    if (typeof raw !== "string" || raw.trim() === "") {
      return err({ kind: "Blank" });
    }
    return parseUsername(raw).mapErr((): UsernameError => ({ kind: "InvalidCharacters" }));
  },
  deriveFromEmail: (
    email: AccessEmailValue,
    baseUsernameTaken: boolean,
  ): Result<Username, UsernameError> => {
    const local = AccessEmail.localPart(email)
      .toLowerCase()
      .replaceAll("-", "_")
      .replace(/[^a-z0-9_]/g, "");
    const sanitized = local.length === 0 ? "user" : local;
    const candidate = baseUsernameTaken
      ? `${sanitized}_${AccessEmail.shortSuffix(email)}`
      : sanitized;
    return Username.parse(candidate);
  },
} as const;
