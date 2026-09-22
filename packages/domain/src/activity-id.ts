import { brandedNonEmptyString, schemaResult } from "@tstodon/core";
import type { z } from "zod";

export const ActivityIdBrand = Symbol("ActivityId");
const schema = brandedNonEmptyString<typeof ActivityIdBrand>();

export type ActivityId = z.infer<typeof schema>;

export const ActivityId = {
  schema,
  parse: schemaResult(schema),
} as const;
