import { z } from "zod";

/** `GET /api/v1/accounts?id[]=`: up to 40 accounts by id. */
export const ApiGetAccountsParamsSchema = z.object({
  id: z.array(z.string()).optional(),
});
export type ApiGetAccountsParams = z.input<typeof ApiGetAccountsParamsSchema>;

/** `GET /api/v1/accounts/familiar_followers?id[]=`. */
export const ApiGetFamiliarFollowersParamsSchema = z.object({
  id: z.array(z.string()).optional(),
});
export type ApiGetFamiliarFollowersParams = z.input<typeof ApiGetFamiliarFollowersParamsSchema>;

/** `POST /api/v1/accounts/:id/note`: the private note on an account (empty clears it). */
export const ApiSetAccountNoteParamsSchema = z.object({
  comment: z.string(),
});
export type ApiSetAccountNoteParams = z.input<typeof ApiSetAccountNoteParamsSchema>;

/** `POST /api/v1/accounts/:id/follow`: the follow's options; the server also reads them from the query. */
export const ApiFollowAccountParamsSchema = z.object({
  reblogs: z.boolean().optional(),
  notify: z.boolean().optional(),
  /** ISO 639 codes; an empty list (or none) shows every language. */
  languages: z.array(z.string()).optional(),
});
export type ApiFollowAccountParams = z.input<typeof ApiFollowAccountParamsSchema>;

/**
 * `GET /api/v1/directory`. `order` is `active` (the default) or `new`; the
 * server reads it case-insensitively and takes anything else as `active`, so
 * it is a string here. tstodon's directory lists local accounts only, so
 * `local` changes nothing.
 */
export const ApiGetDirectoryParamsSchema = z.object({
  offset: z.number().optional(),
  limit: z.number().optional(),
  order: z.string().optional(),
  local: z.boolean().optional(),
});
export type ApiGetDirectoryParams = z.input<typeof ApiGetDirectoryParamsSchema>;

/** One profile field as `fields_attributes` sends it. */
export const ApiProfileFieldParamsSchema = z.object({
  name: z.string().optional(),
  value: z.string().optional(),
});

/**
 * `PATCH /api/v1/accounts/update_credentials`, and `PATCH /api/v1/profile`
 * (Mastodon 4.6), which takes the same fields. Images (`avatar`, `header`)
 * come as multipart files. `fields_attributes` is an array (the web UI's
 * JSON) or an object keyed by position (`fields_attributes[0][name]` in a
 * form). tstodon does not store `avatar_description`, `header_description`,
 * `show_media`, `show_media_replies`, `show_featured` or
 * `attribution_domains` yet: they are read and ignored.
 */
export const ApiUpdateCredentialsParamsSchema = z.object({
  display_name: z.string().optional(),
  note: z.string().optional(),
  avatar: z.unknown().optional(),
  avatar_description: z.string().optional(),
  header: z.unknown().optional(),
  header_description: z.string().optional(),
  locked: z.boolean().optional(),
  bot: z.boolean().optional(),
  discoverable: z.boolean().optional(),
  indexable: z.boolean().optional(),
  hide_collections: z.boolean().optional(),
  show_media: z.boolean().optional(),
  show_media_replies: z.boolean().optional(),
  show_featured: z.boolean().optional(),
  attribution_domains: z.array(z.string()).optional(),
  fields_attributes: z
    .union([
      z.array(ApiProfileFieldParamsSchema),
      z.record(z.string(), ApiProfileFieldParamsSchema),
    ])
    .optional(),
  /** tstodon's earlier name for `fields_attributes` (an array), still read. */
  fields: z.array(ApiProfileFieldParamsSchema).optional(),
  /** Posting defaults. `privacy` and `quote_policy` are checked by the server (422 when unknown). */
  source: z
    .object({
      privacy: z.string().optional(),
      quote_policy: z.string().optional(),
      sensitive: z.boolean().optional(),
      language: z.string().optional(),
    })
    .optional(),
});
export type ApiUpdateCredentialsParams = z.input<typeof ApiUpdateCredentialsParamsSchema>;

/** `PATCH /api/v1/profile`: tstodon reads it as `update_credentials`. */
export const ApiUpdateProfileParamsSchema = ApiUpdateCredentialsParamsSchema;
export type ApiUpdateProfileParams = z.input<typeof ApiUpdateProfileParamsSchema>;
