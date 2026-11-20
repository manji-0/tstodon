import { z } from "zod";
import { IsoInstant } from "./iso-instant";

/**
 * A profile field: a name and a value, and when the value's link was found
 * to link back to the profile (Mastodon's `Account::Field#verified_at`).
 */
export const ProfileFieldSchema = z.object({
  name: z.string(),
  value: z.string(),
  verifiedAt: IsoInstant.schema.optional(),
});

export type ProfileField = z.infer<typeof ProfileFieldSchema>;

const RAW_HTTPS = /^https:\/\/([^/?#]*)([^?#]*)/;

/**
 * Whether `url` is a link Mastodon verifies (`Account::Field#verifiable?`):
 * `https`, no user or password, and a host and a path that are written as
 * they normalize (a lowercase ASCII host, not an IDN one).
 */
const verifiable = (url: string): boolean => {
  const raw = RAW_HTTPS.exec(url);
  if (raw === null || !URL.canParse(url)) {
    return false;
  }
  const [, authority = "", path = ""] = raw;
  const parsed = new URL(url);
  const host = authority.replace(/:\d*$/, "");
  return (
    !authority.includes("@") &&
    host.length > 0 &&
    host === parsed.hostname &&
    (path === "" || path === parsed.pathname)
  );
};

/**
 * Whether a field still waits for its link to be checked, as Mastodon's
 * `requires_verification?`: not verified, and `url`, the link it is checked
 * for (the value of a local field, the one link of a remote field's HTML),
 * is verifiable.
 */
const requiresVerification = (field: ProfileField, url: string | undefined): boolean =>
  field.verifiedAt === undefined && url !== undefined && verifiable(url);

/**
 * The fields an account saves, with the verification of a stored field whose
 * value they keep, as Mastodon's `Account#fields_attributes=`: a changed value
 * is checked again.
 */
const keepVerified = (
  previous: ReadonlyArray<ProfileField>,
  next: ReadonlyArray<Readonly<{ name: string; value: string }>>,
): ProfileField[] =>
  next.map(({ name, value }) => {
    const verifiedAt = previous.find(
      (field) => field.value === value && field.verifiedAt !== undefined,
    )?.verifiedAt;
    return verifiedAt === undefined ? { name, value } : { name, value, verifiedAt };
  });

export const ProfileField = {
  schema: ProfileFieldSchema,
  verifiable,
  requiresVerification,
  keepVerified,
} as const;
