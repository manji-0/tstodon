/**
 * A BlurHash encoder (https://blurha.sh) computing the reference algorithm,
 * so it yields the reference `blurhash` package's string up to floating-point
 * rounding, except where that package departs from the C reference (see the
 * AC maximum below). The package converts every pixel to linear light and
 * calls `Math.cos` twice for each pixel and component (about 47 ms of CPU for
 * a 100x100 image and 4x4 components); this one reads linear light and the
 * cosines from tables and separates the sum into rows and columns, about 1 ms.
 */

const BASE83 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

const encode83 = (value: number, length: number): string => {
  let result = "";
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / 83 ** (length - i)) % 83;
    result += BASE83[digit] ?? "";
  }
  return result;
};

const sRGBToLinear = (value: number): number => {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/** `sRGBToLinear` for every byte value. */
const LINEAR = Float64Array.from({ length: 256 }, (_, value) => sRGBToLinear(value));

const linearTosRGB = (value: number): number => {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308
    ? Math.trunc(v * 12.92 * 255 + 0.5)
    : Math.trunc((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
};

const signPow = (value: number, exponent: number): number =>
  Math.sign(value) * Math.pow(Math.abs(value), exponent);

type Factor = readonly [number, number, number];

const encodeDC = ([r, g, b]: Factor): number =>
  (linearTosRGB(r) << 16) + (linearTosRGB(g) << 8) + linearTosRGB(b);

const quantiseAC = (value: number, maximum: number): number =>
  Math.floor(Math.max(0, Math.min(18, Math.floor(signPow(value / maximum, 0.5) * 9 + 9.5))));

const encodeAC = ([r, g, b]: Factor, maximum: number): number =>
  quantiseAC(r, maximum) * 19 * 19 + quantiseAC(g, maximum) * 19 + quantiseAC(b, maximum);

/** `cos(PI * component * position / size)` for every position. */
const cosines = (component: number, size: number): Float64Array =>
  Float64Array.from({ length: size }, (_, position) =>
    Math.cos((Math.PI * component * position) / size),
  );

/**
 * The BlurHash of RGBA pixels (alpha is ignored, as in the reference), with
 * `componentsX` by `componentsY` components, each from 1 to 9.
 */
export const encodeBlurhash = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  componentsX: number,
  componentsY: number,
): string => {
  if (componentsX < 1 || componentsX > 9 || componentsY < 1 || componentsY > 9) {
    throw new Error("BlurHash must have between 1 and 9 components");
  }
  if (width * height * 4 !== pixels.length) {
    throw new Error("Width and height must match the pixels array");
  }
  // Each column's weighted sums for every horizontal component, per row:
  // the 2D sum separates into a pass over the pixels per horizontal component
  // and a short pass over the rows per vertical one.
  const rows = componentsX * height;
  const red = new Float64Array(rows);
  const green = new Float64Array(rows);
  const blue = new Float64Array(rows);
  for (let x = 0; x < componentsX; x++) {
    const cosX = cosines(x, width);
    for (let row = 0; row < height; row++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let column = 0; column < width; column++) {
        const weight = cosX[column] ?? 0;
        const pixel = (row * width + column) * 4;
        r += weight * (LINEAR[pixels[pixel] ?? 0] ?? 0);
        g += weight * (LINEAR[pixels[pixel + 1] ?? 0] ?? 0);
        b += weight * (LINEAR[pixels[pixel + 2] ?? 0] ?? 0);
      }
      red[x * height + row] = r;
      green[x * height + row] = g;
      blue[x * height + row] = b;
    }
  }
  const factors: Factor[] = [];
  for (let y = 0; y < componentsY; y++) {
    const cosY = cosines(y, height);
    for (let x = 0; x < componentsX; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let row = 0; row < height; row++) {
        const weight = cosY[row] ?? 0;
        r += weight * (red[x * height + row] ?? 0);
        g += weight * (green[x * height + row] ?? 0);
        b += weight * (blue[x * height + row] ?? 0);
      }
      const scale = (x === 0 && y === 0 ? 1 : 2) / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }
  const [dc = [0, 0, 0], ...ac] = factors;
  let hash = encode83(componentsX - 1 + (componentsY - 1) * 9, 1);
  let maximum = 1;
  if (ac.length > 0) {
    // The largest magnitude, as the C reference and Mastodon's `blurhash` gem
    // take it (the JavaScript package takes the largest signed value).
    const actualMaximum = Math.max(...ac.flatMap((factor) => factor.map(Math.abs)));
    const quantisedMaximum = Math.floor(
      Math.max(0, Math.min(82, Math.floor(actualMaximum * 166 - 0.5))),
    );
    maximum = (quantisedMaximum + 1) / 166;
    hash += encode83(quantisedMaximum, 1);
  } else {
    hash += encode83(0, 1);
  }
  hash += encode83(encodeDC(dc), 4);
  for (const factor of ac) {
    hash += encode83(encodeAC(factor, maximum), 2);
  }
  return hash;
};
