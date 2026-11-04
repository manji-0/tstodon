/** Digits in an entity id until the year 2453; ids are stored as TEXT and compared as strings. */
export const ENTITY_ID_DIGITS = 18;

/**
 * A Snowflake-style id that sorts at `atMs` (milliseconds since the epoch),
 * never later than now. Zero-padded, so string order is time order for any
 * instant, as SQL `ORDER BY id` and Mastodon clients compare them.
 */
export const entityIdAt = (atMs: number): string => {
  const at = BigInt(Math.max(0, Math.min(Math.trunc(atMs), Date.now())));
  const bytes = crypto.getRandomValues(new Uint16Array(1));
  const rand = BigInt(bytes[0] ?? 0);
  return ((at << 16n) | rand).toString().padStart(ENTITY_ID_DIGITS, "0");
};

export const newEntityId = (): string => entityIdAt(Date.now());

/**
 * The same instant with fresh random low bits: for an id that collided with
 * one already stored at that instant (backfilled posts often share a second).
 */
export const rerollEntityId = (id: string): string => {
  const bytes = crypto.getRandomValues(new Uint16Array(1));
  const rand = BigInt(bytes[0] ?? 0);
  return ((BigInt(id) & ~0xffffn) | rand).toString().padStart(ENTITY_ID_DIGITS, "0");
};

/**
 * Which instant a stored remote status or boost sorts at. Ones that arrive
 * live sort at `Received`; ones backfilled from an outbox sort at `Published`,
 * so old posts take their place in timelines instead of looking new.
 */
export type IdClock = "Received" | "Published";
