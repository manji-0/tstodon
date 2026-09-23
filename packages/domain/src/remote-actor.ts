import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { IsoInstant } from "./iso-instant";

const RemoteActorSchema = z.object({
  kind: z.literal("RemoteActor"),
  actorUri: z.url(),
  username: z.string().min(1),
  domain: z.string().min(1),
  inboxUri: z.url(),
  sharedInboxUri: z.url().optional(),
  publicKeyId: z.string().min(1),
  publicKeyPem: z.string().min(1),
  displayName: z.string(),
  fetchedAt: IsoInstant.schema,
});

export type RemoteActor = z.infer<typeof RemoteActorSchema>;

export type RemoteActorParseError = Readonly<{ kind: "InvalidActor" }>;

const parseRemoteActor = schemaResult(RemoteActorSchema);

export const RemoteActor = {
  schema: RemoteActorSchema,
  parse: parseRemoteActor,
  fromFetched: (input: {
    actorUri: string;
    username: string;
    domain: string;
    inboxUri: string;
    sharedInboxUri?: string | undefined;
    publicKeyId: string;
    publicKeyPem: string;
    displayName: string;
    fetchedAt: z.infer<typeof IsoInstant.schema>;
  }): Result<RemoteActor, RemoteActorParseError> => {
    const parsed = parseRemoteActor({
      kind: "RemoteActor",
      actorUri: input.actorUri,
      username: input.username,
      domain: input.domain,
      inboxUri: input.inboxUri,
      publicKeyId: input.publicKeyId,
      publicKeyPem: input.publicKeyPem,
      displayName: input.displayName,
      fetchedAt: input.fetchedAt,
      ...(input.sharedInboxUri ? { sharedInboxUri: input.sharedInboxUri } : {}),
    });
    return parsed.mapErr((): RemoteActorParseError => ({ kind: "InvalidActor" }));
  },
  deliveryInbox: (actor: RemoteActor): string => actor.sharedInboxUri ?? actor.inboxUri,
} as const;
