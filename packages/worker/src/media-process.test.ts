import { describe, expect, it } from "vitest";
import { encode as encodeBlurhash } from "blurhash";
import jpeg from "jpeg-js";

describe("blurhash encode path", () => {
  it("encodes a solid-color JPEG sample", () => {
    const width = 8;
    const height = 8;
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 200;
      data[i + 1] = 80;
      data[i + 2] = 40;
      data[i + 3] = 255;
    }
    const encoded = jpeg.encode({ data, width, height }, 50);
    const decoded = jpeg.decode(encoded.data, { useTArray: true });
    const hash = encodeBlurhash(
      new Uint8ClampedArray(decoded.data),
      decoded.width,
      decoded.height,
      4,
      3,
    );
    expect(hash.length).toBeGreaterThan(6);
  });
});
