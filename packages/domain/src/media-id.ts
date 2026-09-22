import { brandedNonEmptyString, schemaResult } from "@tstodon/core";
import type { z } from "zod";

export const MediaIdBrand = Symbol("MediaId");
const schema = brandedNonEmptyString<typeof MediaIdBrand>();

export type MediaId = z.infer<typeof schema>;

export const MediaId = {
  schema,
  parse: schemaResult(schema),
} as const;
