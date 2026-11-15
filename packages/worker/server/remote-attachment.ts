import type { RemoteAttachment } from "@tstodon/domain";
import { isRemoteBlurhash } from "./blurhash";

type AttachmentMetadata = Pick<RemoteAttachment, "blurhash" | "size" | "focus">;

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
 * The blurhash, the size and the focus point an ActivityPub attachment
 * declares (`blurhash`, `width` / `height`, `focalPoint`), as Mastodon's
 * `MediaAttachmentParser` reads them. One that does not read is left out.
 */
export const remoteAttachmentMetadata = (
  entry: Readonly<{ blurhash?: unknown; width?: unknown; height?: unknown; focalPoint?: unknown }>,
): AttachmentMetadata => {
  const width = pixels(entry.width);
  const height = pixels(entry.height);
  const focus = focusOf(entry.focalPoint);
  return {
    ...(typeof entry.blurhash === "string" && isRemoteBlurhash(entry.blurhash)
      ? { blurhash: entry.blurhash }
      : {}),
    ...(width !== undefined && height !== undefined ? { size: { width, height } } : {}),
    ...(focus ? { focus } : {}),
  };
};
