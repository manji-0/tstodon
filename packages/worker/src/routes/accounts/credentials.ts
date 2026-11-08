import {
  FediRole,
  ImageMetadata,
  QuoteApprovalPolicy,
  Visibility,
  type FediRole as FediRoleValue,
  type InstanceIdentity,
  type LocalAccount,
} from "@tstodon/domain";
import { InstanceLimits, schemaResult, warmSchemas } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { type Context } from "hono";
import { findAccountById, setAccountLocked, updateAccountProfile } from "../../account-store";
import { findComposeDefaults, updateAccountDefaults } from "../../account-defaults-store";
import {
  EMPTY_ACCOUNT_PROFILE,
  findAccountProfile,
  upsertAccountProfile,
} from "../../account-profile-store";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readUnknownBody,
  requireSession,
  requireUser,
} from "../../http";
import { accountSource, mastodonAccountDocument } from "../../account-documents";
import { parseInstanceIdentity } from "../../runtime-config";
import { isTruthy } from "../../form-values";
import { newEntityId } from "../../ids";
import { sendActorUpdate } from "../../local-actor";
import { avatarObjectKey, headerObjectKey } from "../../media-keys";
import { ApiRefusal } from "../api-refusal";
import { buildFeaturedTagDocuments } from "../tags";
import { z } from "zod";
import { booleanish } from "../../form-values";

export const UpdateCredentialsBodySchema = z.object({
  display_name: z.string().optional(),
  avatar: z.unknown().optional(),
  header: z.unknown().optional(),
  note: z.string().optional(),
  bot: booleanish,
  discoverable: booleanish,
  indexable: booleanish,
  hide_collections: booleanish,
  locked: booleanish,
  fields: z
    .array(z.object({ name: z.string().optional(), value: z.string().optional() }))
    .optional(),
  source: z
    .object({
      privacy: z.string().optional(),
      quote_policy: z.string().optional(),
      sensitive: z.union([z.boolean(), z.string(), z.number()]).optional(),
      language: z.string().optional(),
    })
    .optional(),
});

/** Mastodon boolean query params: `true`/`1` are on, anything else is off. */
export const queryFlag = (value: string | undefined): boolean => value === "true" || value === "1";

export const getV1AccountsVerifyCredentials = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/verify_credentials">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  return c.json(
    await credentialAccountDocument(
      c.env,
      identity.value,
      session.value.account,
      session.value.role,
    ),
  );
};

/** The signed-in account as `verify_credentials` (and the web app's initial state) show it. */
export const credentialAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  role: FediRoleValue,
): Promise<Record<string, unknown>> => {
  const [document, profile, defaults] = await Promise.all([
    mastodonAccountDocument(env, identity, account),
    findAccountProfile(env.DB, account.id),
    findComposeDefaults(env.DB, account.id),
  ]);
  return {
    ...document,
    role: FediRole.toMastodon(role),
    source: accountSource(
      account,
      profile.isOk() ? profile.value : EMPTY_ACCOUNT_PROFILE,
      defaults.isOk() ? defaults.value : { language: null, sensitive: false },
    ),
  };
};

/** Avatar and header uploads: image types only, up to the advertised size cap. */
const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const storeProfileImage = async (
  env: Env,
  accountId: string,
  kind: "avatar" | "header",
  value: unknown,
): Promise<
  | Readonly<{ kind: "Ok"; objectKey: string | null; contentType: string | null }>
  | Readonly<{ kind: "Err"; message: string }>
> => {
  if (value === undefined || value === null) {
    return { kind: "Ok", objectKey: null, contentType: null };
  }
  if (!(value instanceof File)) {
    return { kind: "Err", message: `${kind} must be sent as a file` };
  }
  const contentType = value.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const allowed: ReadonlyArray<string> = InstanceLimits.media.supportedMimeTypes.filter((type) =>
    type.startsWith("image/"),
  );
  if (!allowed.includes(contentType)) {
    return { kind: "Err", message: `${kind} must be one of ${allowed.join(", ")}` };
  }
  const uploaded = await value.arrayBuffer();
  if (uploaded.byteLength > PROFILE_IMAGE_MAX_BYTES) {
    return { kind: "Err", message: `${kind} exceeds ${PROFILE_IMAGE_MAX_BYTES} bytes` };
  }
  // Stored without EXIF, XMP and the like, as media attachments are.
  const scrubbed = ImageMetadata.forUpload(contentType, new Uint8Array(uploaded));
  if (scrubbed.isErr()) {
    console.warn(
      JSON.stringify({ kind: "ProfileImageRejected", image: kind, error: scrubbed.error }),
    );
    return { kind: "Err", message: `${kind} is not a readable ${contentType} file` };
  }
  const bytes = scrubbed.value;
  // A fresh key per upload, so the immutable cache never serves the old image.
  const blobId = newEntityId();
  const objectKey =
    kind === "avatar" ? avatarObjectKey(accountId, blobId) : headerObjectKey(accountId, blobId);
  await env.MEDIA.put(objectKey, bytes, { httpMetadata: { contentType } });
  return { kind: "Ok", objectKey, contentType };
};

type UpdateCredentialsBody = z.infer<typeof UpdateCredentialsBodySchema>;

type AccountDefaultsUpdate = Parameters<typeof updateAccountDefaults>[2];

/**
 * The posting defaults the request changes, from `source[...]`: flat form
 * keys or a JSON `source` object. Undefined when it names none; an invalid
 * value comes back as the 422 message Mastodon answers with.
 */
const parseSourceDefaults = (
  rawBody: unknown,
  source: UpdateCredentialsBody["source"],
): Result<AccountDefaultsUpdate | undefined, string> => {
  const flat: Record<string, unknown> = schemaResult(z.record(z.string(), z.unknown()))(
    rawBody,
  ).unwrapOr({});
  const sourceKey = (key: "privacy" | "quote_policy"): string | undefined => {
    const flatValue = flat[`source[${key}]`];
    if (typeof flatValue === "string" && flatValue.trim().length > 0) {
      return flatValue.trim();
    }
    return source?.[key]?.trim();
  };
  const privacyRaw = sourceKey("privacy");
  const quotePolicyRaw = sourceKey("quote_policy");
  const sensitiveRaw =
    flat["source[sensitive]"] !== undefined ? flat["source[sensitive]"] : source?.sensitive;
  const languageRaw =
    typeof flat["source[language]"] === "string" ? flat["source[language]"] : source?.language;
  const languageValue =
    typeof languageRaw === "string"
      ? languageRaw.trim().length === 0
        ? null
        : languageRaw.trim().toLowerCase()
      : undefined;
  if (
    languageValue !== undefined &&
    languageValue !== null &&
    !/^[a-z]{2,3}(-[a-z0-9]+)?$/.test(languageValue)
  ) {
    return err("Invalid source[language]");
  }
  const sourceVisibility =
    privacyRaw === undefined ? undefined : Visibility.fromMastodon(privacyRaw);
  if (sourceVisibility?.isErr()) {
    return err("Invalid source[privacy]");
  }
  if (
    quotePolicyRaw !== undefined &&
    quotePolicyRaw !== "public" &&
    quotePolicyRaw !== "followers" &&
    quotePolicyRaw !== "nobody"
  ) {
    return err("Invalid source[quote_policy]");
  }
  if (
    !sourceVisibility &&
    quotePolicyRaw === undefined &&
    sensitiveRaw === undefined &&
    languageValue === undefined
  ) {
    return ok(undefined);
  }
  return ok({
    ...(sourceVisibility?.isOk() ? { visibility: sourceVisibility.value } : {}),
    ...(quotePolicyRaw === undefined
      ? {}
      : {
          quotePolicy:
            quotePolicyRaw === "followers"
              ? QuoteApprovalPolicy.Followers
              : quotePolicyRaw === "nobody"
                ? QuoteApprovalPolicy.Nobody
                : QuoteApprovalPolicy.Public,
        }),
    ...(sensitiveRaw === undefined
      ? {}
      : {
          sensitive: isTruthy(
            typeof sensitiveRaw === "boolean" || typeof sensitiveRaw === "number"
              ? sensitiveRaw
              : String(sensitiveRaw),
          ),
        }),
    ...(languageValue === undefined ? {} : { language: languageValue }),
  });
};

/**
 * Store the bio, profile fields, flags, and avatar/header uploads beside the
 * account row; an omitted value keeps the stored one, and a replaced image is
 * deleted from the media bucket once the new one is saved.
 */
const saveProfile = async (
  env: Env,
  accountId: string,
  body: UpdateCredentialsBody,
): Promise<Result<void, ApiRefusal>> => {
  const existingProfile = await findAccountProfile(env.DB, accountId);
  if (existingProfile.isErr()) {
    return err(ApiRefusal.repository(existingProfile.error.message));
  }
  const existing = existingProfile.value;
  const fields = body.fields
    ?.flatMap((field) => {
      const name = field.name?.trim() ?? "";
      const value = field.value?.trim() ?? "";
      return name.length > 0 && value.length > 0 ? [{ name, value }] : [];
    })
    // Mastodon keeps only the first few profile fields.
    .slice(0, InstanceLimits.account.maxProfileFields);
  // Avatar / header uploads land in the media bucket like any other object.
  const avatar = await storeProfileImage(env, accountId, "avatar", body.avatar);
  if (avatar.kind === "Err") {
    return err(ApiRefusal.rejected(422, avatar.message, "ValidationError"));
  }
  const header = await storeProfileImage(env, accountId, "header", body.header);
  if (header.kind === "Err") {
    return err(ApiRefusal.rejected(422, header.message, "ValidationError"));
  }
  const flag = (value: UpdateCredentialsBody["bot"], stored: boolean): boolean =>
    value === undefined ? stored : isTruthy(value);
  const saved = await upsertAccountProfile(env.DB, accountId, {
    note: body.note === undefined ? existing.note : body.note,
    fields: fields === undefined ? existing.fields : fields,
    bot: flag(body.bot, existing.bot),
    discoverable: flag(body.discoverable, existing.discoverable),
    indexable: flag(body.indexable, existing.indexable),
    hideCollections: flag(body.hide_collections, existing.hideCollections),
    avatarObjectKey: avatar.objectKey ?? existing.avatarObjectKey,
    avatarContentType: avatar.contentType ?? existing.avatarContentType,
    headerObjectKey: header.objectKey ?? existing.headerObjectKey,
    headerContentType: header.contentType ?? existing.headerContentType,
  });
  if (saved.isErr()) {
    return err(ApiRefusal.repository(saved.error.message));
  }
  const replaced = [
    avatar.objectKey === null ? null : existing.avatarObjectKey,
    header.objectKey === null ? null : existing.headerObjectKey,
  ].filter((key): key is string => key !== null);
  if (replaced.length > 0) {
    await env.MEDIA.delete(replaced);
  }
  return ok(undefined);
};

/**
 * Apply `update_credentials`: posting defaults, display name, profile, and
 * the locked flag, in that order, then read the account back.
 */
const updateCredentials = async (
  env: Env,
  account: LocalAccount,
  rawBody: unknown,
  body: UpdateCredentialsBody,
): Promise<Result<LocalAccount, ApiRefusal>> => {
  const defaults = parseSourceDefaults(rawBody, body.source);
  if (defaults.isErr()) {
    return err(ApiRefusal.rejected(422, defaults.error, "ValidationError"));
  }
  if (defaults.value) {
    const stored = await updateAccountDefaults(env.DB, account.id, defaults.value);
    if (stored.isErr()) {
      return err(ApiRefusal.repository(stored.error.message));
    }
  }
  const displayName =
    body.display_name && body.display_name.trim().length > 0
      ? body.display_name.trim()
      : account.displayName;
  const updated = await updateAccountProfile(env.DB, account.id, displayName);
  if (updated.isErr()) {
    return err(ApiRefusal.repository(updated.error.message));
  }
  const profile = await saveProfile(env, account.id, body);
  if (profile.isErr()) {
    return err(profile.error);
  }
  if (body.locked !== undefined) {
    const locked = await setAccountLocked(env.DB, account.id, isTruthy(body.locked));
    if (locked.isErr()) {
      return err(ApiRefusal.repository(locked.error.message));
    }
  }
  const latest = await findAccountById(env.DB, account.id);
  return latest.isErr() || !latest.value
    ? err(ApiRefusal.repository("account missing after update"))
    : ok(latest.value);
};

/** The account document with its `source`, as its owner sees it after a change. */
const ownAccountDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<Record<string, unknown>> => {
  const [document, profile, defaults] = await Promise.all([
    mastodonAccountDocument(env, identity, account),
    findAccountProfile(env.DB, account.id),
    findComposeDefaults(env.DB, account.id),
  ]);
  return {
    ...document,
    source: accountSource(
      account,
      profile.isOk() ? profile.value : EMPTY_ACCOUNT_PROFILE,
      defaults.isOk() ? defaults.value : { language: null, sensitive: false },
    ),
  };
};

export const patchV1AccountsUpdateCredentials = async (
  c: Context<{ Bindings: Env }, "/api/v1/accounts/update_credentials">,
) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rawBody = await readUnknownBody(c);
  const body = schemaResult(UpdateCredentialsBodySchema)(rawBody);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const updated = await updateCredentials(c.env, user.value, rawBody, body.value);
  if (updated.isErr()) {
    return ApiRefusal.respond(c, updated.error);
  }
  await federateProfileChange(c.env, identity.value, updated.value);
  return c.json(await ownAccountDocument(c.env, identity.value, updated.value));
};

/**
 * Tell remote followers the profile changed with an actor `Update`, as
 * Mastodon's credentials and profile-image controllers queue
 * `ActivityPub::UpdateDistributionWorker`. Best effort: the change is stored
 * either way.
 */
const federateProfileChange = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
): Promise<void> => {
  const sent = await sendActorUpdate(env, identity, account);
  if (sent.isErr()) {
    console.error(
      JSON.stringify({
        kind: "ProfileUpdateNotFederated",
        accountId: account.id,
        error: sent.error.kind,
      }),
    );
  }
};

/** `DELETE /api/v1/profile/avatar|header`: drop the image and answer the credential account. */
const deleteProfileImage = async (
  c: Context<{ Bindings: Env }>,
  kind: "avatar" | "header",
): Promise<Response> => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const profile = await findAccountProfile(c.env.DB, user.value.id);
  if (profile.isErr()) {
    return jsonRepositoryError(c, profile.error.message);
  }
  const objectKey =
    kind === "avatar" ? profile.value.avatarObjectKey : profile.value.headerObjectKey;
  // Deleting an image that is not set succeeds without a write, like Mastodon.
  if (objectKey !== null) {
    const saved = await upsertAccountProfile(c.env.DB, user.value.id, {
      ...profile.value,
      ...(kind === "avatar"
        ? { avatarObjectKey: null, avatarContentType: null }
        : { headerObjectKey: null, headerContentType: null }),
    });
    if (saved.isErr()) {
      return jsonRepositoryError(c, saved.error.message);
    }
    await c.env.MEDIA.delete(objectKey);
    await federateProfileChange(c.env, identity.value, user.value);
  }
  return c.json(await ownAccountDocument(c.env, identity.value, user.value));
};

export const deleteV1ProfileAvatar = (c: Context<{ Bindings: Env }, "/api/v1/profile/avatar">) =>
  deleteProfileImage(c, "avatar");
export const deleteV1ProfileHeader = (c: Context<{ Bindings: Env }, "/api/v1/profile/header">) =>
  deleteProfileImage(c, "header");

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([UpdateCredentialsBodySchema]);

const ProfileSourceSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  avatar: z.string(),
  avatar_static: z.string(),
  header: z.string(),
  header_static: z.string(),
  locked: z.boolean(),
  bot: z.boolean(),
  discoverable: z.boolean().nullable().optional(),
  indexable: z.boolean(),
  hide_collections: z.boolean().nullable().optional(),
  note: z.string(),
  fields: z.array(z.unknown()),
  source: z.object({ note: z.string(), fields: z.array(z.unknown()) }),
});

/**
 * Mastodon 4.6's profile-editing document (`REST::ProfileSerializer`): the
 * plain-text note and fields alongside their rendered forms.
 */
const profileDocument = async (
  env: Env,
  identity: InstanceIdentity,
  account: LocalAccount,
  role: FediRoleValue,
): Promise<Record<string, unknown> | undefined> => {
  const [credential, featured] = await Promise.all([
    credentialAccountDocument(env, identity, account, role),
    buildFeaturedTagDocuments(env, identity, account.id, account.username),
  ]);
  const parsed = schemaResult(ProfileSourceSchema)(credential);
  if (parsed.isErr()) {
    return undefined;
  }
  const doc = parsed.value;
  return {
    id: doc.id,
    display_name: doc.display_name,
    note: doc.source.note,
    fields: doc.source.fields,
    formatted_note: doc.note,
    formatted_fields: doc.fields,
    avatar: doc.avatar,
    avatar_static: doc.avatar_static,
    avatar_description: "",
    header: doc.header,
    header_static: doc.header_static,
    header_description: "",
    locked: doc.locked,
    bot: doc.bot,
    hide_collections: doc.hide_collections ?? false,
    discoverable: doc.discoverable ?? false,
    indexable: doc.indexable,
    show_media: true,
    show_media_replies: true,
    show_featured: true,
    attribution_domains: [],
    featured_tags: featured.kind === "Ok" ? featured.documents : [],
  };
};

/** `GET /api/v1/profile` (Mastodon 4.6): the signed-in account's editable profile. */
export const getV1Profile = async (c: Context<{ Bindings: Env }>) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const document = await profileDocument(
    c.env,
    identity.value,
    session.value.account,
    session.value.role,
  );
  return document ? c.json(document) : jsonRepositoryError(c, "profile could not be rendered");
};

/**
 * `PATCH /api/v1/profile` takes `update_credentials`' fields; it answers with
 * the profile document instead of the account.
 */
export const patchV1Profile = async (c: Context<{ Bindings: Env }, "/api/v1/profile">) => {
  const updated = await patchV1AccountsUpdateCredentials(c);
  return updated.status === 200 ? getV1Profile(c) : updated;
};
