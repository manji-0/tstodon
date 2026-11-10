import { characterCount, InstanceLimits, warmSchemas } from "@tstodon/core";
import { ApiCreateStatusParamsSchema } from "@tstodon/api";
import type { z } from "zod";

/**
 * One `media_attributes` entry as the publish and edit flows apply it:
 * `undefined` keeps the attachment's value, and a blank description clears
 * it.
 */
export type MediaAttribute = Readonly<{
  id: string;
  description?: string | undefined;
  focus?: string | undefined;
}>;

/** Whether a media description fits the instance's limit. */
export const mediaDescriptionFits = (description: string): boolean =>
  characterCount(description) <= InstanceLimits.media.maxDescriptionCharacters;

/** Whether every `media_attributes` description fits the instance's limit. */
export const mediaDescriptionsFit = (attributes: ReadonlyArray<MediaAttribute>): boolean =>
  attributes.every(
    (attribute) =>
      attribute.description === undefined || mediaDescriptionFits(attribute.description),
  );

/**
 * A JSON body with its `null` fields removed. Mastodon (Rails) treats a null
 * parameter as absent, and its web UI sends `"in_reply_to_id": null`,
 * `"poll": null`, and so on for whatever the post does not use.
 */
export const withoutNullFields = (raw: unknown): unknown =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null))
    : raw;

/**
 * The `media_attributes` of a parsed create or edit request. A `null`
 * description (what Mastodon's web UI sends for an attachment without
 * one) clears it, as in Mastodon; a `null` focus keeps the attachment's.
 */
export const mediaAttributesOf = (
  attributes: z.output<typeof ApiCreateStatusParamsSchema>["media_attributes"],
): ReadonlyArray<MediaAttribute> =>
  (attributes ?? []).map((attribute) => ({
    id: attribute.id,
    ...(attribute.description === undefined ? {} : { description: attribute.description ?? "" }),
    ...(attribute.focus === undefined || attribute.focus === null
      ? {}
      : { focus: attribute.focus }),
  }));

// Module-init compile so Workers startup `new Function` installs fast paths before requests.
warmSchemas([ApiCreateStatusParamsSchema]);
