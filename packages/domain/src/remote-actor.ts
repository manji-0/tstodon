import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { Hostname } from "./hostname";
import { IsoInstant } from "./iso-instant";

/**
 * What a remote actor shows on its profile. `note` is plain text: the actor's
 * HTML `summary` is reduced to its text, never rendered as markup.
 */
const RemoteActorProfileSchema = z.object({
  note: z.string(),
  avatarUrl: z.url().nullable(),
  headerUrl: z.url().nullable(),
  profileUrl: z.url().nullable(),
  locked: z.boolean(),
  bot: z.boolean(),
  publishedAt: IsoInstant.schema.nullable(),
});

export type RemoteActorProfile = z.infer<typeof RemoteActorProfileSchema>;

const EMPTY_PROFILE: RemoteActorProfile = {
  note: "",
  avatarUrl: null,
  headerUrl: null,
  profileUrl: null,
  locked: false,
  bot: false,
  publishedAt: null,
};

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
  profile: RemoteActorProfileSchema,
  /** The actor this one moved to, once a verified `Move` said so. */
  movedTo: z.url().optional(),
  /** Its `outbox` collection, from which a profile's history is backfilled. */
  outboxUri: z.url().optional(),
  /** Its `featured` collection: the notes it pinned. */
  featuredUri: z.url().optional(),
  fetchedAt: IsoInstant.schema,
});

export type RemoteActor = z.infer<typeof RemoteActorSchema>;

export type RemoteActorParseError = Readonly<{ kind: "InvalidActor" }>;

const parseRemoteActor = schemaResult(RemoteActorSchema);

export const RemoteActor = {
  schema: RemoteActorSchema,
  profileSchema: RemoteActorProfileSchema,
  emptyProfile: EMPTY_PROFILE,
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
    profile?: RemoteActorProfile | undefined;
    movedTo?: string | undefined;
    outboxUri?: string | undefined;
    featuredUri?: string | undefined;
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
      profile: input.profile ?? EMPTY_PROFILE,
      fetchedAt: input.fetchedAt,
      ...(input.sharedInboxUri ? { sharedInboxUri: input.sharedInboxUri } : {}),
      ...(input.movedTo ? { movedTo: input.movedTo } : {}),
      ...(input.outboxUri ? { outboxUri: input.outboxUri } : {}),
      ...(input.featuredUri ? { featuredUri: input.featuredUri } : {}),
    });
    return parsed.mapErr((): RemoteActorParseError => ({ kind: "InvalidActor" }));
  },
  deliveryInbox: (actor: RemoteActor): string => actor.sharedInboxUri ?? actor.inboxUri,
  /**
   * The hostnames a suspension or the allow list is checked against: the
   * account domain's and the actor URI's. The URI host serves the actor and
   * its key, so a WebFinger domain elsewhere never lifts a rule on it.
   */
  hostnames: (actor: RemoteActor): ReadonlyArray<Hostname> => {
    const uriHost = Hostname.ofUri(actor.actorUri);
    return [Hostname.ofAuthority(actor.domain), ...(uriHost ? [uriHost] : [])];
  },
} as const;
