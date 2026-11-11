import { schemaResult } from "@tstodon/core";
import { z } from "zod";

export const IsoInstantBrand = Symbol("IsoInstant");
const schema = z.iso.datetime().brand<typeof IsoInstantBrand>();

export type IsoInstant = z.infer<typeof schema>;

/**
 * A timestamp from a remote document: RFC 3339 with any UTC offset, converted
 * to the canonical UTC form with milliseconds. Timelines order rows by these
 * strings, so every stored instant has to share one shape.
 */
const remoteSchema = z.iso
  .datetime({ offset: true })
  .transform((value, ctx) => {
    const milliseconds = Date.parse(value);
    if (Number.isNaN(milliseconds)) {
      ctx.issues.push({ code: "custom", message: "not a calendar instant", input: value });
      return z.NEVER;
    }
    return new Date(milliseconds).toISOString();
  })
  .pipe(schema);

export const IsoInstant = {
  schema,
  /** Parses canonical UTC (`Z`) text, the form instants are stored in. */
  parse: schemaResult(schema),
  /** Parses a remote document's timestamp, with or without a UTC offset, into canonical UTC. */
  parseRemote: schemaResult(remoteSchema),
} as const;
