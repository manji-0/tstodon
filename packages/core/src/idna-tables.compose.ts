/**
 * The tables of RFC 3454 (stringprep) that nameprep (RFC 3491) uses, read
 * from the RFC's text and packed as strings of base-36 numbers. Run at
 * generation and test time only; `idna.ts` unpacks the strings.
 */

type Range = readonly [start: number, end: number];

/** The lines of table `name`, without the RFC's page breaks. */
const tableLines = (rfc: string, name: string): string[] => {
  const start = rfc.indexOf(`----- Start Table ${name} -----`);
  const end = rfc.indexOf(`----- End Table ${name} -----`);
  if (start === -1 || end === -1) {
    throw new TypeError(`RFC 3454 has no table ${name}`);
  }
  return rfc
    .slice(start, end)
    .split("\n")
    .slice(1)
    .filter((line) => /^ {3}[0-9A-F]{4,6}(?:[-;]|$)/.test(line))
    .map((line) => line.trim());
};

const hex = (text: string): number => Number.parseInt(text, 16);

/** The code points of the tables `names`, as sorted ranges with no gap between two of them. */
const ranges = (rfc: string, names: ReadonlyArray<string>): Range[] => {
  const listed = names
    .flatMap((name) => tableLines(rfc, name))
    .map((line): Range => {
      const [start = "", end = start] = (line.split(";")[0] ?? "").trim().split("-");
      return [hex(start), hex(end)];
    })
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of listed) {
    const last = merged.at(-1);
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
};

const base36 = (numbers: ReadonlyArray<number>): string =>
  numbers.map((number) => number.toString(36)).join(" ");

/** Each range as its distance from the end of the one before and its length less one. */
const packRanges = (list: ReadonlyArray<Range>): string => {
  let previous = 0;
  return base36(
    list.flatMap(([start, end]) => {
      const packed = [start - previous, end - start];
      previous = end;
      return packed;
    }),
  );
};

/**
 * Table B.2 (case folding with NFKC). A code point that maps to one other is
 * in `runs`: `count` code points `stride` apart from `first` (as its
 * distance from the run before), each mapped to itself plus `offset`. One
 * that maps to several is in `sequences`, with them.
 */
const packFold = (rfc: string): { runs: string; sequences: string } => {
  const entries = tableLines(rfc, "B.2").map((line) => {
    const [from = "", to = ""] = line.split(";");
    return { from: hex(from.trim()), to: to.trim().split(" ").map(hex) };
  });
  const runs: { first: number; count: number; stride: number; offset: number }[] = [];
  const sequences: number[][] = [];
  for (const { from, to } of entries) {
    const [target] = to;
    if (to.length !== 1 || target === undefined) {
      sequences.push([from, ...to]);
      continue;
    }
    const offset = target - from;
    const run = runs.at(-1);
    const stride = run === undefined ? 0 : from - (run.first + (run.count - 1) * run.stride);
    if (
      run !== undefined &&
      run.offset === offset &&
      (stride === 1 || stride === 2) &&
      (run.count === 1 || run.stride === stride)
    ) {
      run.stride = stride;
      run.count += 1;
    } else {
      runs.push({ first: from, count: 1, stride: 1, offset });
    }
  }
  let previous = 0;
  return {
    runs: base36(
      runs.flatMap(({ first, count, stride, offset }) => {
        const packed = [first - previous, count, stride, offset];
        previous = first;
        return packed;
      }),
    ),
    sequences: sequences.map(base36).join(","),
  };
};

export const composeIdnaTables = (
  rfc: string,
): Record<
  "mappedToNothing" | "foldRuns" | "foldSequences" | "prohibited" | "randAL" | "l" | "unassigned",
  string
> => {
  const fold = packFold(rfc);
  return {
    mappedToNothing: packRanges(ranges(rfc, ["B.1"])),
    foldRuns: fold.runs,
    foldSequences: fold.sequences,
    prohibited: packRanges(
      ranges(rfc, ["C.1.2", "C.2.2", "C.3", "C.4", "C.5", "C.6", "C.7", "C.8", "C.9"]),
    ),
    randAL: packRanges(ranges(rfc, ["D.1"])),
    l: packRanges(ranges(rfc, ["D.2"])),
    unassigned: packRanges(ranges(rfc, ["A.1"])),
  };
};
