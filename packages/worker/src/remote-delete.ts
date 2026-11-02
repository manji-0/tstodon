import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/** The signer deletes its own account. */
const ActorDeleteSchema = z.object({
  kind: z.literal("ActorDelete"),
  actorUri: z.string().min(1),
});

/** The signer deletes something it published (a note, usually). */
const ObjectDeleteSchema = z.object({
  kind: z.literal("ObjectDelete"),
  objectUri: z.string().min(1),
});

const RemoteDeleteTargetSchema = z.discriminatedUnion("kind", [
  ActorDeleteSchema,
  ObjectDeleteSchema,
]);

export type RemoteDeleteTarget = z.infer<typeof RemoteDeleteTargetSchema>;

export const RemoteDeleteTarget = {
  schema: RemoteDeleteTargetSchema,
  parse: schemaResult(RemoteDeleteTargetSchema),
  /**
   * What a `Delete` signed by `signerUri` removes. Only the signer's own actor
   * URI deletes an actor, so one actor cannot delete another.
   */
  of: (signerUri: string, objectUri: string): RemoteDeleteTarget =>
    objectUri === signerUri
      ? { kind: "ActorDelete", actorUri: signerUri }
      : { kind: "ObjectDelete", objectUri },
} as const;
