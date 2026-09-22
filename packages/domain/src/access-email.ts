import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

export const AccessEmailBrand = Symbol("AccessEmail");

const schema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => {
    const separator = value.indexOf("@");
    if (separator <= 0) {
      return false;
    }
    const local = value.slice(0, separator);
    const domain = value.slice(separator + 1);
    return (
      local.length > 0 &&
      domain.length > 0 &&
      !domain.includes("@") &&
      domain.includes(".") &&
      !domain.startsWith(".") &&
      !domain.endsWith(".")
    );
  })
  .brand<typeof AccessEmailBrand>();

export type AccessEmail = z.infer<typeof schema>;

export type AccessEmailError = Readonly<{ kind: "Blank" }> | Readonly<{ kind: "Invalid" }>;

const fnvChecksum = (value: string): number => {
  let acc = 0;
  for (const char of value) {
    acc = (Math.imul(acc, 16777619) + char.charCodeAt(0)) >>> 0;
  }
  return acc;
};

export const AccessEmail = {
  schema,
  parse: (raw: unknown): Result<AccessEmail, AccessEmailError> => {
    if (typeof raw !== "string" || raw.trim() === "") {
      return err({ kind: "Blank" });
    }
    const parsed = schema.safeParse(raw);
    return parsed.success ? ok(parsed.data) : err({ kind: "Invalid" });
  },
  localPart: (email: AccessEmail): string => {
    const separator = email.indexOf("@");
    return separator === -1 ? "user" : email.slice(0, separator);
  },
  shortSuffix: (email: AccessEmail): string =>
    (fnvChecksum(email) & 0x00ff_ffff).toString(16).padStart(6, "0"),
} as const;
