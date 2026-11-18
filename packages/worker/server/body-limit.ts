import { InstanceLimits } from "@tstodon/core";
import type { Context, Next } from "hono";
import { err, ok, type Result } from "neverthrow";
import { errorPage } from "./auth-pages";
import { MAX_IMPORT_BYTES } from "./csv-import-file";
import { parseSignatureHeader } from "./http-signature";
import { recordInboxRefusal } from "./inbox-refusal";
import { humanSize } from "./media-limits";

/** A body over the cap its reader set. */
export type BodyTooLarge = Readonly<{ kind: "BodyTooLarge"; limitBytes: number }>;

/**
 * Mastodon's `ActivityPub::Activity::MAX_JSON_SIZE` (1 MB): the largest
 * inbox delivery, and the cap on any request body that carries no file.
 */
export const MAX_JSON_BYTES = 1_048_576;

/** Mastodon's `Request#body_with_limit` default (1 MB): the cap on a fetched document. */
export const MAX_FETCHED_BYTES = 1_048_576;

/** Room for a multipart form's boundaries, part headers and text fields around its files. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** An avatar or a header image (`update_credentials`): 5 MB each. */
export const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Mastodon's `CustomEmoji::LOCAL_LIMIT` (256 KB); the handler checks each image against it. */
export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;

const { imageSizeLimit, videoSizeLimit } = InstanceLimits.media;

/**
 * The largest body each upload route takes, by method and path: its files'
 * own limits (checked again per file by the handler) plus form overhead.
 * Every other request with a body is held to {@link MAX_JSON_BYTES}.
 */
const UPLOAD_CAPS: ReadonlyArray<readonly [method: string, path: RegExp, limitBytes: number]> = [
  // The file, and a `thumbnail` image (a video's or an audio file's cover).
  [
    "POST",
    /^\/api\/v[12]\/media$/,
    Math.max(imageSizeLimit, videoSizeLimit) + imageSizeLimit + MULTIPART_OVERHEAD_BYTES,
  ],
  // A changed `thumbnail` (the web UI sends one for a video or audio file).
  ["PUT", /^\/api\/v1\/media\/[^/]+$/, imageSizeLimit + MULTIPART_OVERHEAD_BYTES],
  [
    "PATCH",
    /^\/api\/v1\/(accounts\/update_credentials|profile)$/,
    2 * PROFILE_IMAGE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
  ],
  ["POST", /^\/api\/v1\/admin\/custom_emojis$/, CUSTOM_EMOJI_MAX_BYTES + MULTIPART_OVERHEAD_BYTES],
  [
    "PATCH",
    /^\/api\/v1\/admin\/custom_emojis\/[^/]+$/,
    CUSTOM_EMOJI_MAX_BYTES + MULTIPART_OVERHEAD_BYTES,
  ],
  ["POST", /^\/admin\/custom_emojis$/, CUSTOM_EMOJI_MAX_BYTES + MULTIPART_OVERHEAD_BYTES],
  ["POST", /^\/settings\/imports?$/, MAX_IMPORT_BYTES + MULTIPART_OVERHEAD_BYTES],
];

/** The cap on a request's body; undefined for a method that sends none. */
export const requestBodyCap = (method: string, path: string): number | undefined => {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") {
    return undefined;
  }
  const upload = UPLOAD_CAPS.find(([m, pattern]) => m === verb && pattern.test(path));
  return upload?.[2] ?? MAX_JSON_BYTES;
};

const declaredLength = (headers: Headers): number => {
  const declared = Number(headers.get("content-length") ?? Number.NaN);
  return Number.isFinite(declared) ? declared : 0;
};

/** Requests whose body passed the cap {@link capRequestBody} put on it. */
const overCap = new WeakSet<Request>();

/** True when the request's body passed the cap {@link capRequestBody} put on it. */
export const bodyCapExceeded = (request: Request): boolean => overCap.has(request);

/**
 * Put `limitBytes` on the request's body. A `Content-Length` over it is
 * refused at once, unread. Otherwise the body is replaced by one that fails
 * as soon as more than `limitBytes` have passed (a chunked body declares no
 * length), so whichever reader the handler uses stops there, and
 * {@link bodyCapExceeded} says why it failed. Nothing is buffered here.
 */
export const capRequestBody = (c: Context, limitBytes: number): Result<void, BodyTooLarge> => {
  const raw = c.req.raw;
  if (declaredLength(raw.headers) > limitBytes) {
    return err({ kind: "BodyTooLarge", limitBytes });
  }
  if (raw.body === null) {
    return ok(undefined);
  }
  let size = 0;
  let capped: Request | undefined;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limitBytes) {
        if (capped !== undefined) {
          overCap.add(capped);
        }
        controller.error(new RangeError(`request body exceeds ${limitBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  capped = new Request(raw, { body: raw.body.pipeThrough(limiter) });
  c.req.raw = capped;
  return ok(undefined);
};

/** The inbox paths, whose refusals are logged as `InboxRefused`. */
const INBOX_PATH = /^\/(inbox|actor\/inbox|users\/[^/]+\/inbox)$/;

/**
 * How a route's clients read a refusal: the API's JSON error, the inbox's
 * empty answer (logged as an inbox refusal), or, for the pages the Worker
 * renders, an HTML page a browser shows.
 */
type RefusalAudience = "Api" | "Inbox" | "Page";

const audienceOf = (path: string): RefusalAudience => {
  if (INBOX_PATH.test(path)) {
    return "Inbox";
  }
  return path.startsWith("/api/") || path === "/oauth/token" || path === "/oauth/revoke"
    ? "Api"
    : "Page";
};

/** Mastodon's answer to an oversized body: 413, in the form the route's clients read. */
const bodyTooLarge = (c: Context, limitBytes: number): Response => {
  switch (audienceOf(c.req.path)) {
    case "Api":
      return c.json(
        { error: `Request body exceeds ${limitBytes} bytes`, kind: "PayloadTooLarge" },
        413,
      );
    case "Inbox": {
      const signature = c.req.header("Signature");
      recordInboxRefusal(c.env, {
        reason: "PayloadTooLarge",
        status: 413,
        path: c.req.path,
        keyId: signature === undefined ? undefined : parseSignatureHeader(signature)?.keyId,
      });
      return c.body(null, 413);
    }
    case "Page":
      return c.html(
        errorPage(
          c.env.INSTANCE_NAME || "tstodon",
          `This form sent more than this page accepts (${humanSize(limitBytes)}). Go back and choose a smaller file.`,
        ),
        413,
      );
  }
};

/**
 * The request-wide body cap ({@link requestBodyCap}): a 413 before the
 * handler for a declared length over it, or in place of the handler's answer
 * when the handler's read of a chunked body passed it (unless the handler
 * already answered 413, as the inbox does, having logged it).
 */
export const bodyLimitMiddleware = async (
  c: Context<{ Bindings: Env }>,
  next: Next,
): Promise<Response | void> => {
  const limitBytes = requestBodyCap(c.req.method, c.req.path);
  if (limitBytes === undefined) {
    return next();
  }
  if (capRequestBody(c, limitBytes).isErr()) {
    return bodyTooLarge(c, limitBytes);
  }
  await next();
  if (bodyCapExceeded(c.req.raw) && c.res.status !== 413) {
    c.res = bodyTooLarge(c, limitBytes);
  }
};

/**
 * Read a request's or a response's body, refusing it as soon as it is known
 * to pass `limitBytes`: at once when its `Content-Length` says so, otherwise
 * when the bytes read so far do. The rest of the body is never read.
 */
export const readBodyBytes = async (
  message: Request | Response,
  limitBytes: number,
): Promise<Result<Uint8Array, BodyTooLarge>> => {
  const tooLarge = { kind: "BodyTooLarge", limitBytes } as const satisfies BodyTooLarge;
  if (declaredLength(message.headers) > limitBytes) {
    await message.body?.cancel();
    return err(tooLarge);
  }
  if (message.body === null) {
    return ok(new Uint8Array(0));
  }
  // An identity transform types the chunks, which the runtime's body leaves untyped.
  const reader = message.body
    .pipeThrough(new TransformStream<Uint8Array, Uint8Array>())
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limitBytes) {
        await reader.cancel();
        return err(tooLarge);
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (message instanceof Request && bodyCapExceeded(message)) {
      return err(tooLarge);
    }
    throw cause;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(bytes);
};

/** {@link readBodyBytes} decoded as UTF-8. */
export const readBodyText = async (
  message: Request | Response,
  limitBytes: number,
): Promise<Result<string, BodyTooLarge>> =>
  (await readBodyBytes(message, limitBytes)).map((bytes) => new TextDecoder().decode(bytes));

/** {@link readBodyText} parsed as JSON; `undefined` for a body that is not JSON. */
export const readBodyJson = async (
  message: Request | Response,
  limitBytes: number,
): Promise<Result<unknown, BodyTooLarge>> =>
  (await readBodyText(message, limitBytes)).map((text): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  });
