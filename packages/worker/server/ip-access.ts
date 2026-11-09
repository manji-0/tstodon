import {
  IpBlock,
  type IpBlockList,
  type IpSignUpDecision,
  type ListIpBlocks,
} from "@tstodon/domain";
import type { Context, Next } from "hono";
import { listIpBlocks } from "./ip-block-store";

/**
 * Enforcing IP blocks. The client address is `CF-Connecting-IP`, which
 * Cloudflare sets on every request it forwards to the Worker and overwrites
 * when a client sends its own. A request without it (a local `wrangler dev`
 * or test call that sets none) has no known address and no block applies:
 * `X-Forwarded-For` and `X-Real-IP` are not read, since on Workers they are
 * whatever the client sent. See docs/reference/configuration.md.
 *
 * The block list is read once per isolate and kept for {@link CACHE_TTL_MS};
 * an isolate that changes a block forgets its copy at once, and the others
 * pick the change up within the TTL. Each request then only compares
 * integers against the compiled ranges.
 */

const CACHE_TTL_MS = 60_000;

type CachedList = Readonly<{ list: IpBlockList; loadedAt: number }>;

let cached: CachedList | undefined;
let loading: Promise<IpBlockList> | undefined;

/** The request's client address, or `undefined` when Cloudflare named none. */
export const clientIp = (request: Request): string | undefined => {
  const header = request.headers.get("CF-Connecting-IP")?.trim();
  return header && header.length > 0 ? header : undefined;
};

/** Drop this isolate's copy of the block list (after a block changes). */
export const forgetIpBlocks = (): void => {
  cached = undefined;
  loading = undefined;
};

/**
 * The compiled block list, from this isolate's copy when it is fresh. A read
 * that fails leaves the list empty for this call (fail open: a D1 outage
 * must not lock every client out) and is retried by the next request.
 */
export const currentIpBlocks = async (
  list: ListIpBlocks,
  nowMs: number = Date.now(),
): Promise<IpBlockList> => {
  if (cached && nowMs - cached.loadedAt < CACHE_TTL_MS) {
    return cached.list;
  }
  loading ??= list().then((blocks) => {
    loading = undefined;
    if (blocks.isErr()) {
      return [];
    }
    const compiled = IpBlock.compile(blocks.value);
    cached = { list: compiled, loadedAt: nowMs };
    return compiled;
  });
  return loading;
};

/** What a sign-up from this request's address may do. */
export const ipSignUpDecision = async (request: Request, env: Env): Promise<IpSignUpDecision> => {
  const ip = clientIp(request);
  if (ip === undefined) {
    return { kind: "Open" };
  }
  return IpBlock.signUp(await currentIpBlocks(listIpBlocks(env.DB)), ip, Date.now());
};

/**
 * Request middleware: a `no_access` block refuses every request from its
 * range with 403, before routing, as Mastodon's Rack::Attack blocklist does.
 */
export const ipAccessMiddleware = async (
  c: Context<{ Bindings: Env }, string>,
  next: Next,
): Promise<Response | void> => {
  const ip = clientIp(c.req.raw);
  if (ip === undefined) {
    return next();
  }
  const list = await currentIpBlocks(listIpBlocks(c.env.DB));
  if (list.length > 0 && IpBlock.access(list, ip, Date.now()).kind === "Denied") {
    return c.text("Forbidden\n", 403);
  }
  return next();
};
