/** Digits in an entity id until the year 2453; ids are stored as TEXT and compared as strings. */
export const ENTITY_ID_DIGITS = 18;

const LOW_BITS = 16n;
const LOW_MASK = (1n << LOW_BITS) - 1n;
const LOW_VALUES = 1 << Number(LOW_BITS);

/**
 * How many low values this isolate remembers across instants. Past it, the
 * oldest instants are forgotten, never the one being drawn, so at most 65,536
 * numbers are held. Forgotten instants are ones a burst has moved past;
 * reusing one only risks the 1 in 65,536 match that ids from another isolate
 * already carry.
 */
const REMEMBERED_LOW_VALUES = LOW_VALUES;

/** Low values handed out per instant, oldest instant first. */
const usedLowValues = new Map<bigint, Set<number>>();
let rememberedCount = 0;

const randomLowValue = (): number => crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;

const forgetOldInstants = (keep: bigint): void => {
  for (const [at, used] of usedLowValues) {
    if (rememberedCount <= REMEMBERED_LOW_VALUES) return;
    if (at === keep) continue;
    usedLowValues.delete(at);
    rememberedCount -= used.size;
  }
};

const remember = (at: bigint, used: Set<number>, low: number): void => {
  if (used.has(low)) return;
  used.add(low);
  rememberedCount += 1;
  forgetOldInstants(at);
};

/**
 * A uniformly random low value this isolate has not yet used at `at`. The low
 * bits stay unpredictable because an id is the only secret guarding a media
 * attachment (`attachments/<accountId>/<mediaId>`). Throws once all 65,536 are
 * used, rather than move the id to another instant: a later instant could pass
 * `Date.now()`, which workerd holds still between I/O.
 */
const freshLowValue = (at: bigint, taken?: number): bigint => {
  let used = usedLowValues.get(at);
  if (used === undefined) {
    used = new Set();
    usedLowValues.set(at, used);
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
