import { schemaResult } from "@tstodon/core";
import type { Result } from "neverthrow";
import { z } from "zod";
import { CoveredHosts } from "./covered-hosts";
import { Hostname } from "./hostname";
import { IsoInstant } from "./iso-instant";
import { ProfileFieldSchema } from "./profile-field";

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
  /**
   * The actor's `discoverable` and `indexable` flags. False on a profile
   * stored before they were kept, as Mastodon reads an absent flag.
   */
  discoverable: z.boolean().default(false),
  indexable: z.boolean().default(false),
  publishedAt: IsoInstant.schema.nullable(),
  /**
   * The profile fields, from the actor's `PropertyValue` attachments. `value`
   * is the actor's HTML as sent: sanitise it before it is rendered. None on a
   * profile stored before they were kept.
   */
  fields: z.array(ProfileFieldSchema).default([]),
});

export type RemoteActorProfile = z.infer<typeof RemoteActorProfileSchema>;

const EMPTY_PROFILE: RemoteActorProfile = {
  note: "",
  avatarUrl: null,
  headerUrl: null,
  profileUrl: null,
  locked: false,
  bot: false,
  discoverable: false,
  indexable: false,
  publishedAt: null,
  fields: [],
};

const RemoteActorSchema = z.object({
  kind: z.literal("RemoteActor"),
  actorUri: z.url(),
  username: z.string().min(1),
  domain: z.string().min(1),
  inboxUri: z.url(),
  sharedInboxUri: z.url().optional(),
  displayName: z.string(),
  profile: RemoteActorProfileSchema,
  /** The actor this one moved to, once a verified `Move` said so. */
  movedTo: z.url().optional(),
  /** Its `outbox` collection, from which a profile's history is backfilled. */
  outboxUri: z.url().optional(),
  /** Its `featured` collection: the notes it pinned. */
  featuredUri: z.url().optional(),
  /** Its `featuredTags` collection: the hashtags it features. */
  featuredTagsUri: z.url().optional(),
  /**
   * Its `followers` and `following` collections (Mastodon's `followers_url`
   * / `following_url`), kept only on the actor's own host.
   */
  followersUri: z.url().optional(),
  followingUri: z.url().optional(),
  fetchedAt: IsoInstant.schema,
  /**
   * When WebFinger last confirmed `username@domain` for this actor
   * (Mastodon's `last_webfingered_at`); absent while the handle is only the
   * URI's authority, which the document itself proves.
   */
  webfingeredAt: IsoInstant.schema.optional(),
});

export type RemoteActor = z.infer<typeof RemoteActorSchema>;

export type RemoteActorParseError = Readonly<{ kind: "InvalidActor" }>;

const parseRemoteActor = schemaResult(RemoteActorSchema);

/**
 * Mastodon's `Account::USERNAME_ONLY_RE`, which its `Account` validates a
 * remote account's username against, with `USERNAME_LENGTH_HARD_LIMIT`.
 */
const REMOTE_USERNAME = /^[a-z0-9_]+(?:[.-]+[a-z0-9_]+)*$/i;
const REMOTE_USERNAME_MAX_LENGTH = 2048;

const hostnames = (actor: RemoteActor): ReadonlyArray<Hostname> => {
  const uriHost = Hostname.ofUri(actor.actorUri);
  return [Hostname.ofAuthority(actor.domain), ...(uriHost ? [uriHost] : [])];
};

/** Whether `url` is on the host of `actorUri`, ignoring case (Mastodon's `mismatching_origin?`). */
const sameHost = (url: string, actorUri: string): boolean => {
  const host = Hostname.ofUri(url);
  return host !== undefined && host === Hostname.ofUri(actorUri);
};

export const RemoteActor = {
  schema: RemoteActorSchema,
  profileSchema: RemoteActorProfileSchema,
  sameHost,
  emptyProfile: EMPTY_PROFILE,
  parse: parseRemoteActor,
  /**
   * The actor's `url`, its profile page, or its id when it names none or one
   * on another host, as Mastodon's `ProcessAccountService#url` drops it
   * (`mismatching_origin?`): an actor cannot claim another's profile.
   */
  profileUrl: (actor: RemoteActor): string => {
    const { profileUrl } = actor.profile;
    return profileUrl !== null && sameHost(profileUrl, actor.actorUri)
      ? profileUrl
      : actor.actorUri;
  },
  fromFetched: (input: {
    actorUri: string;
    username: string;
    domain: string;
    inboxUri: string;
    sharedInboxUri?: string | undefined;
    displayName: string;
    profile?: RemoteActorProfile | undefined;
    movedTo?: string | undefined;
    outboxUri?: string | undefined;
    featuredUri?: string | undefined;
    featuredTagsUri?: string | undefined;
    followersUri?: string | undefined;
    followingUri?: string | undefined;
    fetchedAt: z.infer<typeof IsoInstant.schema>;
    webfingeredAt?: z.infer<typeof IsoInstant.schema> | undefined;
  }): Result<RemoteActor, RemoteActorParseError> => {
    const parsed = parseRemoteActor({
      kind: "RemoteActor",
      actorUri: input.actorUri,
      username: input.username,
      domain: input.domain,
      inboxUri: input.inboxUri,
      displayName: input.displayName,
      profile: input.profile ?? EMPTY_PROFILE,
      fetchedAt: input.fetchedAt,
      ...(input.sharedInboxUri ? { sharedInboxUri: input.sharedInboxUri } : {}),
      ...(input.movedTo ? { movedTo: input.movedTo } : {}),
      ...(input.outboxUri ? { outboxUri: input.outboxUri } : {}),
      ...(input.featuredUri ? { featuredUri: input.featuredUri } : {}),
      ...(input.featuredTagsUri ? { featuredTagsUri: input.featuredTagsUri } : {}),
      ...(input.followersUri ? { followersUri: input.followersUri } : {}),
      ...(input.followingUri ? { followingUri: input.followingUri } : {}),
      ...(input.webfingeredAt ? { webfingeredAt: input.webfingeredAt } : {}),
    });
    return parsed.mapErr((): RemoteActorParseError => ({ kind: "InvalidActor" }));
  },
  /** Whether Mastodon would store a remote account under `username` (its `preferredUsername`). */
  acceptsUsername: (username: string): boolean =>
    username.length <= REMOTE_USERNAME_MAX_LENGTH && REMOTE_USERNAME.test(username),
  deliveryInbox: (actor: RemoteActor): string => actor.sharedInboxUri ?? actor.inboxUri,
  /**
   * The hostnames a domain rule is checked against: the account domain's and
   * the actor URI's. An instance rule (a suspension, silence, `reject_media`,
   * `reject_reports`, the allow list) and a user's domain block both apply
   * when they name either, so an account domain elsewhere never lifts a rule
   * on the host that serves the actor and its key.
   */
  hostnames,
  /** True when an instance rule covering either of the actor's hosts applies to it. */
  onAnyHost: (actor: RemoteActor, covered: CoveredHosts): boolean =>
    hostnames(actor).some((host) => CoveredHosts.covers(covered, host)),
} as const;
