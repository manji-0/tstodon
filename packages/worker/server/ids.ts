/** Digits in an entity id until the year 2453; ids are stored as TEXT and compared as strings. */
export const ENTITY_ID_DIGITS = 18;

const LOW_BITS = 16n;
const LOW_MASK = (1n << LOW_BITS) - 1n;
const LOW_VALUES = 1 << Number(LOW_BITS);

/**
 * How much this isolate remembers: at most 65,536 low values and at most 256
 * instants, whichever limit is hit first. Past either, the instants it first
 * drew at longest ago are forgotten, never the one being drawn. With ids on
 * distinct milliseconds the instant cap keeps the map to a few hundred small
 * entries instead of 65,536 one-value sets (about 15 MB in a long-lived
 * isolate). A forgotten instant is usually one the clock has moved past;
 * drawing at it again only risks the 1 in 65,536 match that ids from another
 * isolate already carry.
 */
const REMEMBERED_LOW_VALUES = LOW_VALUES;
const REMEMBERED_INSTANTS = 256;

/** Low values handed out per instant, in the order each instant was first drawn, and their count. */
type DrawnIds = { usedLowValues: Map<bigint, Set<number>>; rememberedCount: number };

const isDrawnIds = (value: unknown): value is DrawnIds =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "usedLowValues") instanceof Map &&
  typeof Reflect.get(value, "rememberedCount") === "number";

/**
 * The isolate's memory, kept on `globalThis` rather than in this module: a
 * Worker test loads the server source beside the built Worker, two copies of
 * this module in one isolate, and each would otherwise hand out the other's
 * ids at an instant they share.
 */
const drawn: DrawnIds = (() => {
  const key = Symbol.for("tstodon.drawn-entity-ids");
  const shared: unknown = Reflect.get(globalThis, key);
  if (isDrawnIds(shared)) {
    return shared;
  }
  const fresh: DrawnIds = { usedLowValues: new Map(), rememberedCount: 0 };
  Reflect.set(globalThis, key, fresh);
  return fresh;
})();

const randomLowValue = (): number => crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;

const forgetOldInstants = (keep: bigint): void => {
  for (const [at, used] of drawn.usedLowValues) {
    if (
      drawn.rememberedCount <= REMEMBERED_LOW_VALUES &&
      drawn.usedLowValues.size <= REMEMBERED_INSTANTS
    ) {
      return;
    }
    if (at === keep) continue;
    drawn.usedLowValues.delete(at);
    drawn.rememberedCount -= used.size;
  }
};

const remember = (at: bigint, used: Set<number>, low: number): void => {
  if (used.has(low)) return;
  used.add(low);
  drawn.rememberedCount += 1;
  forgetOldInstants(at);
};

/**
 * A uniformly random low value this isolate has not yet used at `at`. Throws
 * once all 65,536 are used, rather than move the id to another instant: a
 * later instant could pass `Date.now()`, which workerd holds still between I/O.
 */
const freshLowValue = (at: bigint, taken?: number): bigint => {
  let used = drawn.usedLowValues.get(at);
  if (used === undefined) {
    used = new Set();
    drawn.usedLowValues.set(at, used);
  }
  if (taken !== undefined) remember(at, used, taken);
  if (used.size >= LOW_VALUES) {
    throw new Error(`all ${LOW_VALUES} entity ids at instant ${at} are used in this isolate`);
  }
  let low = randomLowValue();
  while (used.has(low)) low = randomLowValue();
  remember(at, used, low);
  return BigInt(low);
};

const formatId = (id: bigint): string => id.toString().padStart(ENTITY_ID_DIGITS, "0");

/**
 * A Snowflake-style id that sorts at `atMs` (milliseconds since the epoch),
 * never later than now: the instant above the low 16 bits, a random value no
 * earlier id from this isolate took at that instant in them. Zero-padded, so
 * string order is time order for any instant, as SQL `ORDER BY id` and
 * Mastodon clients compare them.
 */
export const entityIdAt = (atMs: number): string => {
  const at = BigInt(Math.max(0, Math.min(Math.trunc(atMs), Date.now())));
  return formatId((at << LOW_BITS) | freshLowValue(at));
};

export const newEntityId = (): string => entityIdAt(Date.now());

/** The lowest id at `atMs`: every id drawn before that instant sorts under it. */
export const firstEntityIdAt = (atMs: number): string =>
  formatId(BigInt(Math.max(0, Math.trunc(atMs))) << LOW_BITS);

/** The instant (ms since the epoch) an entity id sorts at, or undefined for a string that is no entity id. */
export const entityIdInstant = (id: string): number | undefined =>
  /^\d{1,19}$/.test(id) ? Number(BigInt(id) >> LOW_BITS) : undefined;

/** The id just above `id` in entity id order: `< nextEntityId(id)` is `<= id`. */
export const nextEntityId = (id: string): string => formatId(BigInt(id) + 1n);

/**
 * The same instant with fresh random low bits: for an id that collided with
 * one another isolate stored at that instant. The collided value counts as
 * used, so no later draw returns it.
 */
export const rerollEntityId = (id: string): string => {
  const at = BigInt(id) >> LOW_BITS;
  const taken = Number(BigInt(id) & LOW_MASK);
  return formatId((at << LOW_BITS) | freshLowValue(at, taken));
};

/**
 * Which instant a stored remote status or boost sorts at. Ones that arrive
 * live sort at `Received`; ones backfilled from an outbox sort at `Published`,
 * so old posts take their place in timelines instead of looking new.
 */
export type IdClock = "Received" | "Published";
