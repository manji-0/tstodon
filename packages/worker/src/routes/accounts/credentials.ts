import { FediRole, QuoteApprovalPolicy, Visibility } from "@tstodon/domain";
import { InstanceLimits, schemaResult, warmSchemas } from "@tstodon/core";
import { type Context, Hono } from "hono";
import {
  findAccountById,
  findComposeDefaults,
  setAccountLocked,
  updateAccountDefaults,
  updateAccountProfile,
} from "../../account-store";
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

export const accountCredentialRoutes = new Hono<{ Bindings: Env }>();

/** Mastodon boolean query params: `true`/`1` are on, anything else is off. */
export const queryFlag = (value: string | undefined): boolean => value === "true" || value === "1";

accountCredentialRoutes.get("/api/v1/accounts/verify_credentials", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const session = await requireSession(c);
  if (session.isErr()) {
    return jsonAuthError(c, session.error);
  }
  const [document, profile, defaults] = await Promise.all([
    mastodonAccountDocument(c.env, identity.value, session.value.account),
    findAccountProfile(c.env.DB, session.value.account.id),
    findComposeDefaults(c.env.DB, session.value.account.id),
  ]);
  return c.json({
    ...document,
    role: FediRole.toMastodon(session.value.role),
    source: accountSource(
      session.value.account,
      profile.isOk() ? profile.value : EMPTY_ACCOUNT_PROFILE,
      defaults.isOk() ? defaults.value : { language: null, sensitive: false },
    ),
  });
});

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
  const bytes = await value.arrayBuffer();
  if (bytes.byteLength > PROFILE_IMAGE_MAX_BYTES) {
    return { kind: "Err", message: `${kind} exceeds ${PROFILE_IMAGE_MAX_BYTES} bytes` };
  }
  const objectKey = `${kind}s/${accountId}`;
  await env.MEDIA.put(objectKey, bytes, { httpMetadata: { contentType } });
  return { kind: "Ok", objectKey, contentType };
};

accountCredentialRoutes.patch("/api/v1/accounts/update_credentials", async (c) => {
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.json(identity.error, 500);
  }
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const rawBody = await readUnknownBody(c);
  const body = schemaResult(UpdateCredentialsBodySchema)(rawBody).mapErr(() => ({
    kind: "ValidationError" as const,
  }));
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  // `source[privacy]` and `source[quote_policy]` arrive as flat form keys or
  // nested in a JSON `source` object.
  const flat = (rawBody ?? {}) as Record<string, unknown>;
  const sourceKey = (key: "privacy" | "quote_policy"): string | undefined => {
    const flatValue = flat[`source[${key}]`];
    if (typeof flatValue === "string" && flatValue.trim().length > 0) {
      return flatValue.trim();
    }
    return body.value.source?.[key]?.trim();
  };
  const privacyRaw = sourceKey("privacy");
  const quotePolicyRaw = sourceKey("quote_policy");
  const sensitiveRaw =
    flat["source[sensitive]"] !== undefined
      ? flat["source[sensitive]"]
      : body.value.source?.sensitive;
  const languageRaw =
    typeof flat["source[language]"] === "string"
      ? flat["source[language]"]
      : body.value.source?.language;
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
    return c.json({ error: "Invalid source[language]", kind: "ValidationError" }, 422);
  }
  const sourceVisibility =
    privacyRaw === undefined ? undefined : Visibility.fromMastodon(privacyRaw);
  if (sourceVisibility?.isErr()) {
    return c.json({ error: "Invalid source[privacy]", kind: "ValidationError" }, 422);
  }
  if (
    quotePolicyRaw !== undefined &&
    quotePolicyRaw !== "public" &&
    quotePolicyRaw !== "followers" &&
    quotePolicyRaw !== "nobody"
  ) {
    return c.json({ error: "Invalid source[quote_policy]", kind: "ValidationError" }, 422);
  }
  if (
    sourceVisibility ||
    quotePolicyRaw !== undefined ||
    sensitiveRaw !== undefined ||
    languageValue !== undefined
  ) {
    const defaults = await updateAccountDefaults(c.env.DB, user.value.id, {
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
    if (defaults.isErr()) {
      return jsonRepositoryError(c, defaults.error.message);
    }
  }
  const displayName =
    body.value.display_name && body.value.display_name.trim().length > 0
      ? body.value.display_name.trim()
      : user.value.displayName;
  const updated = await updateAccountProfile(c.env.DB, user.value.id, displayName);
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }

  // Bio, profile fields, and the bot/discoverable flags live beside the row.
  const existingProfile = await findAccountProfile(c.env.DB, user.value.id);
  if (existingProfile.isErr()) {
    return jsonRepositoryError(c, existingProfile.error.message);
  }
  const fields = body.value.fields
    ?.flatMap((field) => {
      const name = field.name?.trim() ?? "";
      const value = field.value?.trim() ?? "";
      return name.length > 0 && value.length > 0 ? [{ name, value }] : [];
    })
    // Mastodon keeps only the first few profile fields.
    .slice(0, InstanceLimits.account.maxProfileFields);
  // Avatar / header uploads land in the media bucket like any other object.
  const uploaded = await storeProfileImage(c.env, user.value.id, "avatar", body.value.avatar);
  if (uploaded.kind === "Err") {
    return c.json({ error: uploaded.message, kind: "ValidationError" }, 422);
  }
  const header = await storeProfileImage(c.env, user.value.id, "header", body.value.header);
  if (header.kind === "Err") {
    return c.json({ error: header.message, kind: "ValidationError" }, 422);
  }
  const saved = await upsertAccountProfile(c.env.DB, user.value.id, {
    note: body.value.note === undefined ? existingProfile.value.note : body.value.note,
    fields: fields === undefined ? existingProfile.value.fields : fields,
    bot: body.value.bot === undefined ? existingProfile.value.bot : isTruthy(body.value.bot),
    discoverable:
      body.value.discoverable === undefined
        ? existingProfile.value.discoverable
        : isTruthy(body.value.discoverable),
    indexable:
      body.value.indexable === undefined
        ? existingProfile.value.indexable
        : isTruthy(body.value.indexable),
    hideCollections:
      body.value.hide_collections === undefined
        ? existingProfile.value.hideCollections
        : isTruthy(body.value.hide_collections),
    avatarObjectKey: uploaded.objectKey ?? existingProfile.value.avatarObjectKey,
    avatarContentType: uploaded.contentType ?? existingProfile.value.avatarContentType,
    headerObjectKey: header.objectKey ?? existingProfile.value.headerObjectKey,
    headerContentType: header.contentType ?? existingProfile.value.headerContentType,
  });
  if (saved.isErr()) {
    return jsonRepositoryError(c, saved.error.message);
  }
  if (body.value.locked !== undefined) {
    const locked = await setAccountLocked(c.env.DB, user.value.id, isTruthy(body.value.locked));
    if (locked.isErr()) {
      return jsonRepositoryError(c, locked.error.message);
    }
  }
  const latest = await findAccountById(c.env.DB, user.value.id);
  if (latest.isErr() || !latest.value) {
    return jsonRepositoryError(c, "account missing after update");
  }
  const [document, profileAfter, defaultsAfter] = await Promise.all([
    mastodonAccountDocument(c.env, identity.value, latest.value),
    findAccountProfile(c.env.DB, user.value.id),
    findComposeDefaults(c.env.DB, user.value.id),
  ]);
  return c.json({
    ...document,
    source: accountSource(
      latest.value,
      profileAfter.isOk() ? profileAfter.value : EMPTY_ACCOUNT_PROFILE,
      defaultsAfter.isOk() ? defaultsAfter.value : { language: null, sensitive: false },
    ),
  });
});

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
  }
  const [document, profileAfter, defaults] = await Promise.all([
    mastodonAccountDocument(c.env, identity.value, user.value),
    findAccountProfile(c.env.DB, user.value.id),
    findComposeDefaults(c.env.DB, user.value.id),
  ]);
  return c.json({
    ...document,
    source: accountSource(
      user.value,
      profileAfter.isOk() ? profileAfter.value : EMPTY_ACCOUNT_PROFILE,
      defaults.isOk() ? defaults.value : { language: null, sensitive: false },
    ),
  });
};

accountCredentialRoutes.delete("/api/v1/profile/avatar", (c) => deleteProfileImage(c, "avatar"));
accountCredentialRoutes.delete("/api/v1/profile/header", (c) => deleteProfileImage(c, "header"));

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([UpdateCredentialsBodySchema]);
