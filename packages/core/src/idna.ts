import { IDNA_TABLES } from "./idna-tables";

/**
 * IDNA2003's ToASCII (RFC 3490) as GNU libidn's `idna_to_ascii_8z` does it
 * with its default flags, which is what Mastodon's server asks of a URL's
 * host (twitter-text's `is_valid_domain` calls `IDN::Idna.toASCII`):
 * nameprep (RFC 3491) on Unicode 3.2, then punycode (RFC 3492). It imports
 * no package, so the web UI loads it with `@tstodon/core/post-text`.
 */

/** Sorted ranges as `[start, end, start, end, …]`, unpacked from `composeIdnaTables`' string. */
const unpackRanges = (packed: string): Uint32Array => {
  let previous = 0;
  return Uint32Array.from(packed.split(" "), (number) => {
    previous += Number.parseInt(number, 36);
    return previous;
  });
};

const includes = (ranges: Uint32Array, codePoint: number): boolean => {
  let low = 0;
  let high = ranges.length / 2;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (codePoint > (ranges[2 * middle + 1] ?? 0)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < ranges.length / 2 && codePoint >= (ranges[2 * low] ?? 0);
};

const unpackFold = (runs: string, sequences: string): Map<number, string> => {
  const fold = new Map<number, string>();
  const numbers = runs.split(" ").map((number) => Number.parseInt(number, 36));
  let first = 0;
  for (let i = 0; i < numbers.length; i += 4) {
    first += numbers[i] ?? 0;
    const [count = 0, stride = 0, offset = 0] = numbers.slice(i + 1, i + 4);
    for (let n = 0; n < count; n += 1) {
      fold.set(first + n * stride, String.fromCodePoint(first + n * stride + offset));
    }
  }
  for (const sequence of sequences.split(",")) {
    const [from = 0, ...to] = sequence.split(" ").map((number) => Number.parseInt(number, 36));
    fold.set(from, String.fromCodePoint(...to));
  }
  return fold;
};

/**
 * Where a browser's NFKC is not Unicode 3.2's for a character Unicode 3.2
 * has: the decompositions Unicode later corrected (Corrigendum 4), which
 * libidn keeps.
 */
const NFKC_OF_UNICODE_3_2 = new Map([
  [0x2f868, 0x2136a],
  [0x2f874, 0x5f33],
  [0x2f91f, 0x43ab],
  [0x2f95f, 0x7aae],
  [0x2f9bf, 0x4d57],
]);

/** Whether a character of NFKC text has a combining class other than 0: a mark that canonical ordering moves. */
const isNonStarter = (character: string): boolean =>
  `${character}\u0334`.normalize("NFD").startsWith("\u0334") ||
  `\u0315${character}`.normalize("NFD").endsWith("\u0315");

/** Whether two non-starters have different combining classes: canonical ordering swaps them one way round. */
const differInClass = (a: string, b: string): boolean =>
  (a + b).normalize("NFD") !== a + b || (b + a).normalize("NFD") !== b + a;

/**
 * NFKC text as libidn composes it. Its NFKC (an early GLib's) composes a
 * character with the last starter whenever the character before it has
 * another combining class, where Unicode asks for a higher one. So a
 * starter composes across marks (`ᄀ`, a mark, `ᅡ` is `가` and the mark),
 * and then so does a mark after it.
 */
const composedAcrossMarks = (nfkc: string): string => {
  const composed: string[] = [];
  let starter = -1;
  let across = false;
  for (const character of nfkc) {
    const previous = composed.at(-1) ?? "";
    const startsAnew = !isNonStarter(character);
    if (
      starter !== -1 &&
      starter < composed.length - 1 &&
      (startsAnew || (across && differInClass(previous, character)))
    ) {
      const pair = `${composed[starter] ?? ""}${character}`.normalize("NFC");
      if (pair.length === ((pair.codePointAt(0) ?? 0) > 0xffff ? 2 : 1)) {
        composed[starter] = pair;
        across = true;
        continue;
      }
    }
    if (startsAnew) {
      starter = composed.length;
      across = false;
    }
    composed.push(character);
  }
  return composed.join("");
};

type Tables = {
  readonly mappedToNothing: Uint32Array;
  readonly fold: Map<number, string>;
  readonly prohibited: Uint32Array;
  readonly randAL: Uint32Array;
  readonly l: Uint32Array;
  readonly unassigned: Uint32Array;
};

let unpacked: Tables | undefined;
/** Unpacked at the first host that is not ASCII. */
const tables = (): Tables =>
  (unpacked ??= {
    mappedToNothing: unpackRanges(IDNA_TABLES.mappedToNothing),
    fold: unpackFold(IDNA_TABLES.foldRuns, IDNA_TABLES.foldSequences),
    prohibited: unpackRanges(IDNA_TABLES.prohibited),
    randAL: unpackRanges(IDNA_TABLES.randAL),
    l: unpackRanges(IDNA_TABLES.l),
    unassigned: unpackRanges(IDNA_TABLES.unassigned),
  });

/**
 * A label's code points after nameprep without unassigned code points
 * allowed, or `undefined` where stringprep fails: a code point Unicode 3.2
 * does not assign, a prohibited one, or text in both directions.
 */
const nameprep = (label: string): number[] | undefined => {
  const { mappedToNothing, fold, prohibited, randAL, l, unassigned } = tables();
  let mapped = "";
  for (const character of label) {
    const codePoint = character.codePointAt(0) ?? 0;
    // libidn looks for unassigned code points last, after an NFKC that
    // leaves them as they are. This NFKC is a later Unicode's, which may
    // decompose them, so they are refused before it.
    if (includes(unassigned, codePoint)) {
      return undefined;
    }
    if (!includes(mappedToNothing, codePoint)) {
      const corrected = NFKC_OF_UNICODE_3_2.get(codePoint);
      mapped +=
        corrected === undefined
          ? (fold.get(codePoint) ?? character)
          : String.fromCodePoint(corrected);
    }
  }
  const prepared = Array.from(
    composedAcrossMarks(mapped.normalize("NFKC")),
    (character) => character.codePointAt(0) ?? 0,
  );
  let hasRandAL = false;
  let hasL = false;
  for (const codePoint of prepared) {
    if (includes(prohibited, codePoint)) {
      return undefined;
    }
    hasRandAL ||= includes(randAL, codePoint);
    hasL ||= includes(l, codePoint);
  }
  // RFC 3454 section 6: text with a right-to-left character has no
  // left-to-right one, and starts and ends with a right-to-left one.
  if (
    hasRandAL &&
    (hasL || !includes(randAL, prepared[0] ?? 0) || !includes(randAL, prepared.at(-1) ?? 0))
  ) {
    return undefined;
  }
  return prepared;
};

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const digit = (value: number): string => String.fromCharCode(value + (value < 26 ? 97 : 22));

/** RFC 3492 section 6.3, for code points of which at least one is not ASCII. */
const punycode = (codePoints: ReadonlyArray<number>): string => {
  let output = String.fromCharCode(...codePoints.filter((codePoint) => codePoint < 0x80));
  const basic = output.length;
  if (basic > 0) {
    output += "-";
  }
  let n = 0x80;
  let delta = 0;
  let bias = 72;
  for (let handled = basic; handled < codePoints.length;) {
    let next = 0x110000;
    for (const codePoint of codePoints) {
      if (codePoint >= n && codePoint < next) {
        next = codePoint;
      }
    }
    delta += (next - n) * (handled + 1);
    n = next;
    for (const codePoint of codePoints) {
      if (codePoint < n) {
        delta += 1;
      } else if (codePoint === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = Math.min(Math.max(k - bias, T_MIN), T_MAX);
          if (q < t) {
            break;
          }
          output += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += digit(q);
        delta = Math.floor(delta / (handled === basic ? 700 : 2));
        delta += Math.floor(delta / (handled + 1));
        let k = 0;
        for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) {
          delta = Math.floor(delta / (BASE - T_MIN));
        }
        bias = k + Math.floor(((BASE - T_MIN + 1) * delta) / (delta + 38));
        delta = 0;
        handled += 1;
      }
    }
    delta += 1;
    n += 1;
  }
  return output;
};

const MAX_LABEL_LENGTH = 63;
const ASCII = /^\p{ASCII}*$/u;

/** RFC 3490 section 4.1 without `UseSTD3ASCIIRules`: an ASCII label is taken as written. */
const labelToAscii = (label: string): string | undefined => {
  let ascii = label;
  if (!ASCII.test(label)) {
    const prepared = nameprep(label);
    // Punycode writes at least one octet per code point, and takes their
    // number squared in time.
    if (prepared === undefined || prepared.length > MAX_LABEL_LENGTH) {
      return undefined;
    }
    ascii = String.fromCodePoint(...prepared);
    if (!ASCII.test(ascii)) {
      if (ascii.startsWith("xn--")) {
        return undefined;
      }
      ascii = `xn--${punycode(prepared)}`;
    }
  }
  return ascii.length >= 1 && ascii.length <= MAX_LABEL_LENGTH ? ascii : undefined;
};

/** The dots IDNA2003 separates labels at (RFC 3490 section 3.1). */
const DOT = /[.。．｡]/;

/**
 * `domain` in ASCII, each label that is not ASCII as `xn--` and punycode,
 * or `undefined` where libidn's `IDN::Idna.toASCII` raises: a label that
 * nameprep refuses, an empty one, or one over 63 octets. The last label may
 * be empty (`example.com.`).
 */
export const toAscii = (domain: string): string | undefined => {
  const labels = domain.split(DOT);
  if (labels.length === 2 && labels.join("") === "") {
    return ".";
  }
  const ascii: string[] = [];
  for (const [index, label] of labels.entries()) {
    const converted = label === "" && index === labels.length - 1 ? "" : labelToAscii(label);
    if (converted === undefined) {
      return undefined;
    }
    ascii.push(converted);
  }
  return ascii.join(".");
};
