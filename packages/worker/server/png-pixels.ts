/**
 * A minimal PNG decoder for the small thumbnails the IMAGES binding returns:
 * non-interlaced images of any colour type at bit depth 1 to 16, inflated with
 * the runtime's `DecompressionStream`. Enough to sample pixels for a blurhash,
 * without a decoding dependency in the bundle.
 */

export type RgbaPixels = Readonly<{ width: number; height: number; pixels: Uint8ClampedArray }>;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Channels per pixel by colour type: grey, RGB, palette, grey + alpha, RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const inflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undo each scanline's filter in place, returning the rows without filter bytes. */
const unfilter = (
  data: Uint8Array,
  rowBytes: number,
  height: number,
  bytesPerPixel: number,
): Uint8Array | undefined => {
  if (data.length < (rowBytes + 1) * height) {
    return undefined;
  }
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)];
    const source = y * (rowBytes + 1) + 1;
    const row = y * rowBytes;
    const previous = row - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const raw = data[source + i] ?? 0;
      const left = i >= bytesPerPixel ? (out[row + i - bytesPerPixel] ?? 0) : 0;
      const up = y > 0 ? (out[previous + i] ?? 0) : 0;
      const upLeft = y > 0 && i >= bytesPerPixel ? (out[previous + i - bytesPerPixel] ?? 0) : 0;
      const predicted =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : filter === 4
                  ? paeth(left, up, upLeft)
                  : undefined;
      if (predicted === undefined) {
        return undefined;
      }
      out[row + i] = (raw + predicted) & 0xff;
    }
  }
  return out;
};

/** The `index`th sample of a row, scaled to 0..255. */
const sample = (rows: Uint8Array, rowStart: number, index: number, depth: number): number => {
  if (depth === 8) {
    return rows[rowStart + index] ?? 0;
  }
  if (depth === 16) {
    return rows[rowStart + index * 2] ?? 0;
  }
  const bit = index * depth;
  const byte = rows[rowStart + Math.floor(bit / 8)] ?? 0;
  const value = (byte >> (8 - depth - (bit % 8))) & ((1 << depth) - 1);
  return Math.round((value * 255) / ((1 << depth) - 1));
};

/** The raw palette index of a palette image's `index`th pixel. */
const paletteIndex = (rows: Uint8Array, rowStart: number, index: number, depth: number): number => {
  if (depth === 8) {
    return rows[rowStart + index] ?? 0;
  }
  const bit = index * depth;
  const byte = rows[rowStart + Math.floor(bit / 8)] ?? 0;
  return (byte >> (8 - depth - (bit % 8))) & ((1 << depth) - 1);
};

const readUint32 = (bytes: Uint8Array, offset: number): number =>
  (((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)) >>>
  0;

/**
 * Decode a PNG to RGBA. `undefined` for anything else, for an interlaced or
 * damaged file, or one with more than `maxPixels` pixels.
 */
export const decodePng = async (
  bytes: Uint8Array,
  maxPixels: number,
): Promise<RgbaPixels | undefined> => {
  if (SIGNATURE.some((value, index) => bytes[index] !== value)) {
    return undefined;
  }
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = -1;
  let interlaced = false;
  let palette: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) {
      return undefined;
    }
    if (type === "IHDR") {
      width = readUint32(data, 0);
      height = readUint32(data, 4);
      depth = data[8] ?? 0;
      colourType = data[9] ?? -1;
      interlaced = data[12] !== 0;
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = CHANNELS[colourType];
  if (
    channels === undefined ||
    interlaced ||
    width === 0 ||
    height === 0 ||
    width * height > maxPixels ||
    ![1, 2, 4, 8, 16].includes(depth) ||
    (colourType === 3 && (palette === undefined || depth === 16)) ||
    (depth < 8 && colourType !== 0 && colourType !== 3)
  ) {
    return undefined;
  }
  const compressed = new Uint8Array(idat.reduce((total, chunk) => total + chunk.length, 0));
  let position = 0;
  for (const chunk of idat) {
    compressed.set(chunk, position);
    position += chunk.length;
  }
  const rowBytes = Math.ceil((width * channels * depth) / 8);
  const bytesPerPixel = Math.max(1, (channels * depth) / 8);
  const rows = unfilter(await inflate(compressed), rowBytes, height, bytesPerPixel);
  if (!rows) {
    return undefined;
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (colourType === 3) {
        const entry = paletteIndex(rows, rowStart, x, depth) * 3;
        pixels[out] = palette?.[entry] ?? 0;
        pixels[out + 1] = palette?.[entry + 1] ?? 0;
        pixels[out + 2] = palette?.[entry + 2] ?? 0;
        pixels[out + 3] = 255;
        continue;
      }
      const values = Array.from({ length: channels }, (_, channel) =>
        sample(rows, rowStart, x * channels + channel, depth),
      );
      const [first = 0, second = 0, third = 0, fourth = 255] = values;
      if (channels <= 2) {
        pixels[out] = first;
        pixels[out + 1] = first;
        pixels[out + 2] = first;
        pixels[out + 3] = channels === 2 ? second : 255;
      } else {
        pixels[out] = first;
        pixels[out + 1] = second;
        pixels[out + 2] = third;
        pixels[out + 3] = channels === 4 ? fourth : 255;
      }
    }
  }
  return { width, height, pixels };
};
