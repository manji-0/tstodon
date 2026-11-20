import { schemaResult } from "@tstodon/core";
import type { RemoteAttachment } from "@tstodon/domain";
import { z } from "zod";
import { isRemoteBlurhash } from "./blurhash";
import { httpUrl } from "./sanitize-html";

type AttachmentMetadata = Pick<RemoteAttachment, "blurhash" | "size" | "focus" | "thumbnailUrl">;

const parseIconObject = schemaResult(z.looseObject({ url: z.string() }));

/**
 * The thumbnail an attachment's `icon` names, as Mastodon's
 * `MediaAttachmentParser#thumbnail_remote_url`: a URL, or the `url` of an
 * object; one that is not http(s) is left out.
 */
const thumbnailOf = (icon: unknown): string | undefined => {
  if (typeof icon === "string") {
    return httpUrl(icon);
  }
  const object = parseIconObject(icon);
  return object.isOk() ? httpUrl(object.value.url) : undefined;
};

const pixels = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

const clamp = (value: number): number => Math.max(-1, Math.min(1, value));

/**
 * The focal point: Mastodon federates `[x, y]` and also reads `"x,y"`
 * (`MediaAttachment#focus=`). Each axis is held to -1..1, the range the REST
 * API documents.
 */
const focusOf = (focalPoint: unknown): AttachmentMetadata["focus"] => {
  const parts: ReadonlyArray<unknown> =
    typeof focalPoint === "string"
      ? focalPoint.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part)))
      : Array.isArray(focalPoint)
        ? focalPoint
        : [];
  const [x, y] = parts;
  return parts.length === 2 &&
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y)
    ? { x: clamp(x), y: clamp(y) }
    : undefined;
};

/**
 * The blurhash, the size, the focus point and the thumbnail an ActivityPub
 * attachment declares (`blurhash`, `width` / `height`, `focalPoint`, `icon`),
 * as Mastodon's `MediaAttachmentParser` reads them. One that does not read is
 * left out.
 */
export const remoteAttachmentMetadata = (
  entry: Readonly<{
    blurhash?: unknown;
    width?: unknown;
    height?: unknown;
    focalPoint?: unknown;
    icon?: unknown;
  }>,
): AttachmentMetadata => {
  const width = pixels(entry.width);
  const height = pixels(entry.height);
  const focus = focusOf(entry.focalPoint);
  const thumbnailUrl = thumbnailOf(entry.icon);
  return {
    ...(thumbnailUrl !== undefined ? { thumbnailUrl } : {}),
    ...(typeof entry.blurhash === "string" && isRemoteBlurhash(entry.blurhash)
      ? { blurhash: entry.blurhash }
      : {}),
    ...(width !== undefined && height !== undefined ? { size: { width, height } } : {}),
    ...(focus ? { focus } : {}),
  };
};
