import { brandedNonEmptyString, schemaResult } from "@tstodon/core";
import type { z } from "zod";

export const StatusIdBrand = Symbol("StatusId");
const schema = brandedNonEmptyString<typeof StatusIdBrand>();

export type StatusId = z.infer<typeof schema>;

export const StatusId = {
  schema,
  parse: schemaResult(schema),
} as const;
