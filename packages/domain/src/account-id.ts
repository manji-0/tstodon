import { brandedNonEmptyString, schemaResult } from "@tstodon/core";
import type { z } from "zod";

export const AccountIdBrand = Symbol("AccountId");
const schema = brandedNonEmptyString<typeof AccountIdBrand>();

export type AccountId = z.infer<typeof schema>;

export const AccountId = {
  schema,
  parse: schemaResult(schema),
} as const;
