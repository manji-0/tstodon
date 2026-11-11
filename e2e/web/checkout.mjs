// Which checkout's e2e servers answer. The ports are fixed, so a second
// checkout running `pnpm e2e:web` at the same time would otherwise pass
// Playwright's readiness checks with the first one's servers (its own fail
// to bind) and run its scenarios against the other code and database. The
// readiness URLs in playwright.config.ts carry this checkout's id, and only
// this checkout's servers answer them.
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A short id of this checkout (its absolute path). */
export const checkoutId = createHash("sha256").update(root).digest("hex").slice(0, 16);

/** The prefix the access edge strips from this checkout's readiness URL. */
export const checkoutPrefix = `/__e2e/${checkoutId}`;
