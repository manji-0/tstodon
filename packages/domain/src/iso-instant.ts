import { schemaResult } from "@tstodon/core";
import { z } from "zod";

export const IsoInstantBrand = Symbol("IsoInstant");
const schema = z.iso.datetime().brand<typeof IsoInstantBrand>();

export type IsoInstant = z.infer<typeof schema>;

export const IsoInstant = {
  schema,
  parse: schemaResult(schema),
} as const;
