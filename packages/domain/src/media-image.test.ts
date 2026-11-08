import { describe, expect, it } from "vite-plus/test";
import { ImageDimensions } from "./media-image";

describe("ImageDimensions", () => {
  it("shrinks to Mastodon's small style, 230,400 pixels, keeping the aspect ratio", () => {
    const small = ImageDimensions.fitWithin(
      { width: 4000, height: 3000 },
      ImageDimensions.smallPixels,
    );
    expect(small).toEqual({ width: 554, height: 415 });
    expect(small.width * small.height).toBeLessThanOrEqual(230_400);
    expect(ImageDimensions.fitWithin({ width: 1280, height: 720 }, 230_400)).toEqual({
      width: 640,
      height: 360,
    });
  });

  it("never enlarges an image already within the limit", () => {
    expect(ImageDimensions.fitWithin({ width: 200, height: 100 }, 230_400)).toEqual({
      width: 200,
      height: 100,
    });
  });

  it("keeps at least one pixel on each side of an extreme panorama", () => {
    expect(ImageDimensions.fitWithin({ width: 1_000_000, height: 1 }, 230_400)).toEqual({
      width: 480_000,
      height: 1,
    });
  });

  it("describes a size as Mastodon's meta does", () => {
    expect(ImageDimensions.meta({ width: 640, height: 480 })).toEqual({
      width: 640,
      height: 480,
      size: "640x480",
      aspect: 640 / 480,
    });
  });
});
