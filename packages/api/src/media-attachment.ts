import { z } from "zod";

/** One size's `meta` entry for an image (`original`, `small`). */
export const ApiImageAttachmentMeta = z.object({
  width: z.number(),
  height: z.number(),
  size: z.string(),
  aspect: z.number(),
});
export type ApiImageAttachmentMetaJSON = z.infer<typeof ApiImageAttachmentMeta>;

/** `meta.original` for video, GIFV and audio. */
export const ApiVideoAttachmentMeta = z.object({
  width: z.number().optional(),
  height: z.number().optional(),
  frame_rate: z.string().optional(),
  duration: z.number().optional(),
  bitrate: z.number().optional(),
});
export type ApiVideoAttachmentMetaJSON = z.infer<typeof ApiVideoAttachmentMeta>;

export const ApiColorsAttachmentMeta = z.object({
  background: z.string(),
  foreground: z.string(),
  accent: z.string(),
});
export type ApiColorsAttachmentMetaJSON = z.infer<typeof ApiColorsAttachmentMeta>;

/** `meta.focus`: the focal point, each axis from -1 to 1. */
export const ApiFocusAttachmentMeta = z.object({ x: z.number(), y: z.number() });
export type ApiFocusAttachmentMetaJSON = z.infer<typeof ApiFocusAttachmentMeta>;

const base = {
  id: z.string(),
  url: z.string(),
  preview_url: z.string().nullable(),
  remote_url: z.string().nullable(),
  preview_remote_url: z.string().nullable().optional(),
  /** Deprecated by Mastodon; kept by older servers. */
  text_url: z.string().nullable().optional(),
  description: z.string().nullable(),
  blurhash: z.string().nullable(),
};

/**
 * `REST::MediaAttachmentSerializer`, discriminated on Mastodon's own `type`.
 * `meta` sizes are present once the server has read them: an upload it could
 * not process (or a remote attachment) has none.
 */
export const ApiImageAttachment = z.object({
  ...base,
  type: z.literal("image"),
  meta: z.object({
    original: ApiImageAttachmentMeta.optional(),
    small: ApiImageAttachmentMeta.optional(),
    focus: ApiFocusAttachmentMeta.optional(),
  }),
});
export type ApiImageAttachmentJSON = z.infer<typeof ApiImageAttachment>;

export const ApiGifvAttachment = z.object({
  ...base,
  type: z.literal("gifv"),
  meta: z.object({
    original: ApiVideoAttachmentMeta.optional(),
    small: ApiImageAttachmentMeta.optional(),
    focus: ApiFocusAttachmentMeta.optional(),
  }),
});
export type ApiGifvAttachmentJSON = z.infer<typeof ApiGifvAttachment>;

export const ApiVideoAttachment = z.object({
  ...base,
  type: z.literal("video"),
  meta: z.object({
    colors: ApiColorsAttachmentMeta.optional(),
    original: ApiVideoAttachmentMeta.optional(),
    small: ApiImageAttachmentMeta.optional(),
    focus: ApiFocusAttachmentMeta.optional(),
  }),
});
export type ApiVideoAttachmentJSON = z.infer<typeof ApiVideoAttachment>;

export const ApiAudioAttachment = z.object({
  ...base,
  type: z.literal("audio"),
  meta: z.object({
    colors: ApiColorsAttachmentMeta.optional(),
    original: ApiVideoAttachmentMeta.optional(),
    small: ApiImageAttachmentMeta.optional(),
  }),
});
export type ApiAudioAttachmentJSON = z.infer<typeof ApiAudioAttachment>;

export const ApiUnknownAttachment = z.object({
  ...base,
  type: z.literal("unknown"),
  meta: z.unknown(),
});
export type ApiUnknownAttachmentJSON = z.infer<typeof ApiUnknownAttachment>;

export const ApiMediaAttachment = z.discriminatedUnion("type", [
  ApiImageAttachment,
  ApiGifvAttachment,
  ApiVideoAttachment,
  ApiAudioAttachment,
  ApiUnknownAttachment,
]);
export type ApiMediaAttachmentJSON = z.infer<typeof ApiMediaAttachment>;
export type BaseApiMediaAttachmentJSON = ApiMediaAttachmentJSON;
