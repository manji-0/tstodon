import { schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import type { RepositoryError } from "./d1";

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ActivityJsonSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    actor: z.string().min(1),
    object: z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]),
  })
  .passthrough();

export const NestedActivityObjectSchema = z
  .object({
    type: z.string().min(1),
    object: z.union([z.string().min(1), z.object({ id: z.string().min(1) }).passthrough()]),
  })
  .passthrough();

export const PollOptionSchema = z.object({
  title: z.string(),
  votesCount: z.number().int().nonnegative(),
});

export const PollOptionsSchema = z.array(PollOptionSchema);

export const FilterContextSchema = z.array(z.string());

export const RsaPrivateJwkSchema = z.object({
  kty: z.literal("RSA"),
  n: z.string().min(1),
  e: z.string().min(1),
  d: z.string().min(1),
  p: z.string().min(1),
  q: z.string().min(1),
  dp: z.string().min(1),
  dq: z.string().min(1),
  qi: z.string().min(1),
  alg: z.string().optional(),
  ext: z.boolean().optional(),
  key_ops: z.array(z.string()).optional(),
});

export const AccountRowSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  access_email: z.string().min(1),
  display_name: z.string(),
  locked: z.number(),
  default_post_visibility: z.string(),
  default_quote_policy: z.string(),
  public_key_pem: z.string().min(1),
  private_key_jwk: z.string().min(1),
  created_at: z.string().min(1),
  bio_text: z.string(),
  avatar_object_key: z.string().nullable(),
  header_object_key: z.string().nullable(),
});

export const StatusRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  kind: z.string().min(1),
  reblog_of_id: z.string().nullable(),
  in_reply_to_id: z.string().nullable(),
  content_text: z.string(),
  content_html: z.string(),
  visibility: z.string(),
  sensitive: z.number(),
  spoiler_text: z.string(),
  language: z.string().nullable(),
  created_at: z.string().min(1),
  poll_id: z.string().nullable(),
});

export const PollRowSchema = z.object({
  id: z.string().min(1),
  status_id: z.string().min(1),
  multiple: z.number(),
  expires_at: z.string().min(1),
  options_json: z.string().min(1),
});

export const ExpiredPollTargetRowSchema = z.object({
  id: z.string().min(1),
  status_id: z.string().min(1),
  account_id: z.string().min(1),
});

export const OutboundActivityRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  kind: z.string().min(1),
  payload_json: z.string().min(1),
  created_at: z.string().min(1),
});

export const OutboxDeliveryRowSchema = z.object({
  kind: z.string().min(1),
  reason_kind: z.string().nullable(),
  attempt_count: z.number(),
  http_status: z.number().nullable(),
  inbox_url: z.string().nullable(),
});

const booleanish = z.union([z.boolean(), z.string(), z.number()]).optional();

export const CreateStatusBodySchema = z.object({
  status: z.string().optional(),
  spoiler_text: z.string().optional(),
  sensitive: booleanish,
  visibility: z.string().optional(),
  language: z.string().optional(),
  in_reply_to_id: z.string().optional(),
  media_ids: z.union([z.array(z.string()), z.string()]).optional(),
  poll: z
    .object({
      options: z.array(z.string()),
      expires_in: z.union([z.number(), z.string()]).optional(),
      multiple: booleanish,
    })
    .optional(),
});

export const PollVoteBodySchema = z.object({
  choices: z.union([z.array(z.union([z.number(), z.string()])), z.number(), z.string()]),
});

export const FilterBodySchema = z.object({
  phrase: z.string().trim().min(1),
  context: z.union([z.array(z.string()), z.string()]).optional(),
  whole_word: booleanish,
  irreversible: booleanish,
  expires_in: z.union([z.number(), z.string()]).optional(),
});

export const ReportBodySchema = z.object({
  account_id: z.string().min(1),
  status_ids: z.union([z.array(z.string()), z.string()]).optional(),
  comment: z.string().optional(),
});

export const AppBodySchema = z.object({
  client_name: z.string().optional(),
  website: z.string().optional(),
  redirect_uris: z.union([z.string(), z.array(z.string())]).optional(),
});

export const OAuthTokenBodySchema = z.object({
  username: z.string().min(1),
});

export const UpdateCredentialsBodySchema = z.object({
  display_name: z.string().optional(),
  avatar: z.unknown().optional(),
  header: z.unknown().optional(),
});

export const MastodonAccountPreviewSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  acct: z.string().min(1),
  avatar: z.string().url().optional(),
  header: z.string().url().optional(),
  role: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      highlighted: z.boolean(),
    })
    .optional(),
});

export const MastodonStatusPreviewSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  favourited: z.boolean().optional(),
  favourites_count: z.number().optional(),
  reblogs_count: z.number().optional(),
  in_reply_to_id: z.string().nullable().optional(),
  in_reply_to_account_id: z.string().nullable().optional(),
  account: MastodonAccountPreviewSchema,
  poll: z
    .object({ id: z.string().min(1) })
    .nullable()
    .optional(),
});

export const MastodonContextPreviewSchema = z.object({
  ancestors: z.array(MastodonStatusPreviewSchema),
  descendants: z.array(MastodonStatusPreviewSchema),
});

export const MastodonAppPreviewSchema = z.object({
  name: z.string(),
  client_id: z.string(),
});

export const MastodonRelationshipPreviewSchema = z.object({
  id: z.string().min(1),
  following: z.boolean(),
});

export const MastodonNotificationPreviewSchema = z.object({
  type: z.string().min(1),
});

export const MastodonSearchPreviewSchema = z.object({
  accounts: z.array(MastodonAccountPreviewSchema),
});

export const MastodonFilterPreviewSchema = z.object({
  phrase: z.string(),
});

export const MastodonReportPreviewSchema = z.object({
  action_taken: z.boolean(),
});

export const MastodonStatusListPreviewSchema = z.array(MastodonStatusPreviewSchema);

export const MastodonNotificationListPreviewSchema = z.array(MastodonNotificationPreviewSchema);

export const MastodonRelationshipListPreviewSchema = z.array(MastodonRelationshipPreviewSchema);

export const MastodonMediaPreviewSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  preview_url: z.string().url(),
});

export const WebfingerPreviewSchema = z.object({
  subject: z.string(),
});

export const ActorPreviewSchema = z.object({
  type: z.literal("Person"),
  preferredUsername: z.string(),
});

export const ActorPublicKeySchema = z.object({
  id: z.string().min(1),
  owner: z.string().min(1),
  publicKeyPem: z.string().min(1),
});

export const ActorDocumentSchema = z
  .object({
    id: z.string().min(1),
    preferredUsername: z.string().min(1),
    inbox: z.string().min(1),
    publicKey: ActorPublicKeySchema,
    name: z.string().optional(),
    endpoints: z
      .object({
        sharedInbox: z.string().min(1).optional(),
      })
      .optional(),
  })
  .passthrough();

export const RemoteActorRowSchema = z.object({
  actor_uri: z.string().min(1),
  username: z.string().min(1),
  domain: z.string().min(1),
  inbox_uri: z.string().min(1),
  shared_inbox_uri: z.string().nullable(),
  public_key_id: z.string().min(1),
  public_key_pem: z.string().min(1),
  display_name: z.string(),
  fetched_at: z.string().min(1),
});

export const NoteDocumentSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("Note"),
    attributedTo: z.string().min(1),
    content: z.string(),
    published: z.string().min(1),
    url: z.string().optional(),
    to: z.union([z.string(), z.array(z.string())]).optional(),
    cc: z.union([z.string(), z.array(z.string())]).optional(),
    sensitive: booleanish,
    summary: z.string().nullable().optional(),
    inReplyTo: z.string().nullable().optional(),
  })
  .passthrough();

export const RemoteStatusRowSchema = z.object({
  id: z.string().min(1),
  actor_uri: z.string().min(1),
  object_uri: z.string().min(1),
  url: z.string().nullable(),
  content_html: z.string(),
  spoiler_text: z.string(),
  visibility: z.string().min(1),
  sensitive: z.number(),
  language: z.string().nullable(),
  published_at: z.string().min(1),
});

export const NotePreviewSchema = z.object({
  type: z.literal("Note"),
});

export const JoseErrorCodeSchema = z.object({
  code: z.string().min(1),
});

export const AccessJwtSchema = z
  .object({
    sub: z.string().min(1),
    email: z.string().min(1).optional(),
    type: z.string().optional(),
    groups: z.array(z.string()).optional(),
    custom: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const JsonWebKeySchema = z
  .object({
    kty: z.string().min(1),
    kid: z.string().optional(),
    alg: z.string().optional(),
  })
  .passthrough();

export const AccessJwksSchema = z.object({
  keys: z.array(JsonWebKeySchema).min(1),
});

export const toRepositoryError = (message: string): RepositoryError => ({
  kind: "RepositoryError",
  message,
});

export const parseRow = <T>(schema: z.ZodType<T>, value: unknown): Result<T, RepositoryError> =>
  schemaResult(schema)(value).mapErr(() => toRepositoryError("invalid row"));

export const parseJsonText = (raw: string): Result<unknown, RepositoryError> => {
  try {
    return ok(JSON.parse(raw));
  } catch {
    return err(toRepositoryError("invalid json"));
  }
};

export const parseJsonColumn = <T>(schema: z.ZodType<T>, raw: string): Result<T, RepositoryError> =>
  parseJsonText(raw).andThen((value) =>
    schemaResult(schema)(value).mapErr(() => toRepositoryError("invalid json column")),
  );

export const isTruthy = (value: boolean | string | number | undefined): boolean =>
  value === true || value === "true" || value === "1" || value === 1;

export const stringList = (value: ReadonlyArray<string> | string | undefined): string[] => {
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : value.slice();
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
};

export const numberList = (value: ReadonlyArray<number | string> | number | string): number[] => {
  const items = Array.isArray(value) ? value : [value];
  const out: number[] = [];
  for (const item of items) {
    const n = typeof item === "number" ? item : Number.parseInt(item, 10);
    if (Number.isInteger(n)) {
      out.push(n);
    }
  }
  return out;
};

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([
  JsonObjectSchema,
  ActivityJsonSchema,
  NestedActivityObjectSchema,
  PollOptionSchema,
  PollOptionsSchema,
  FilterContextSchema,
  RsaPrivateJwkSchema,
  AccountRowSchema,
  StatusRowSchema,
  PollRowSchema,
  ExpiredPollTargetRowSchema,
  OutboundActivityRowSchema,
  OutboxDeliveryRowSchema,
  CreateStatusBodySchema,
  PollVoteBodySchema,
  FilterBodySchema,
  ReportBodySchema,
  AppBodySchema,
  OAuthTokenBodySchema,
  UpdateCredentialsBodySchema,
  MastodonAccountPreviewSchema,
  MastodonStatusPreviewSchema,
  MastodonContextPreviewSchema,
  MastodonAppPreviewSchema,
  MastodonRelationshipPreviewSchema,
  MastodonNotificationPreviewSchema,
  MastodonSearchPreviewSchema,
  MastodonFilterPreviewSchema,
  MastodonReportPreviewSchema,
  MastodonStatusListPreviewSchema,
  MastodonNotificationListPreviewSchema,
  MastodonRelationshipListPreviewSchema,
  MastodonMediaPreviewSchema,
  WebfingerPreviewSchema,
  ActorPreviewSchema,
  ActorPublicKeySchema,
  ActorDocumentSchema,
  RemoteActorRowSchema,
  NoteDocumentSchema,
  RemoteStatusRowSchema,
  NotePreviewSchema,
  JoseErrorCodeSchema,
  AccessJwtSchema,
  JsonWebKeySchema,
  AccessJwksSchema,
]);
