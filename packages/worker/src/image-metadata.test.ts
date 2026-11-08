import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { exifOrientation, ImageMetadata, type StrippedImage } from "@tstodon/domain";
import {
  AVIF_8X6_WITH_METADATA,
  containsText,
  exifWithGps,
  JPEG_800X600,
  jpegSegments,
  jpegWithMetadata,
  PNG_40X30,
  pngChunks,
  pngWithMetadata,
  SECRETS,
  SRGB_ICC,
  WEBP_8X6,
  webpChunks,
  webpWithMetadata,
} from "../test/image-fixtures";
import { decodePng } from "./png-pixels";

const strip = (bytes: Uint8Array): StrippedImage => {
  const result = ImageMetadata.strip(bytes);
  if (result.isErr() || result.value.kind !== "Stripped") {
    throw new Error(`not stripped: ${JSON.stringify(result)}`);
  }
  return result.value;
};

const malformedReason = (bytes: Uint8Array): string | undefined => {
  const result = ImageMetadata.strip(bytes);
  return result.isErr() ? result.error.reason : undefined;
};

const expectNoSecrets = (bytes: Uint8Array): void => {
  for (const secret of [...Object.values(SECRETS), "secret-copyright"]) {
    expect(containsText(bytes, secret), secret).toBe(false);
  }
};

/** The IFD0 tags of a TIFF block, which must be only the Orientation. */
const ifd0Tags = (tiff: Uint8Array): ReadonlyArray<number> => {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49;
  const ifd = view.getUint32(4, little);
  return Array.from({ length: view.getUint16(ifd, little) }, (_, i) =>
    view.getUint16(ifd + 2 + i * 12, little),
  );
};

const dimensionsOf = async (bytes: Uint8Array): Promise<unknown> => {
  const info = await env.IMAGES.info(new Blob([bytes]).stream());
  return "width" in info ? { width: info.width, height: info.height } : info;
};

const startsWithBytes = (bytes: Uint8Array, prefix: Uint8Array): boolean =>
  prefix.every((value, index) => bytes[index] === value);

describe("ImageMetadata.strip: JPEG", () => {
  it("drops EXIF with GPS, XMP, IPTC, comments and trailing bytes, and keeps the ICC profile", async () => {
    const input = jpegWithMetadata();
    expect(containsText(input, SECRETS.camera)).toBe(true);

    const out = strip(input);

    expect(out.format).toBe("jpeg");
    expect(out.orientation).toBeUndefined();
    expectNoSecrets(out.bytes);
    const markers = jpegSegments(out.bytes).map((segment) => segment.marker);
    expect(markers).not.toContain(0xe1);
    expect(markers).not.toContain(0xed);
    expect(markers).not.toContain(0xfe);
    const icc = jpegSegments(out.bytes).find((segment) => segment.marker === 0xe2);
    expect(icc && startsWithBytes(icc.data.subarray(14), SRGB_ICC)).toBe(true);
    expect([...out.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
    // The image segments and scan are copied as they were.
    expect(out.bytes.length).toBe(JPEG_800X600.length + (icc?.data.length ?? 0) + 4);
    expect(await dimensionsOf(out.bytes)).toEqual({ width: 800, height: 600 });
  });

  it("keeps only the orientation of a rotated photo", async () => {
    const out = strip(jpegWithMetadata(6));

    expect(out.orientation).toBe(6);
    expectNoSecrets(out.bytes);
    const app1 = jpegSegments(out.bytes).filter((segment) => segment.marker === 0xe1);
    expect(app1).toHaveLength(1);
    const exif = app1[0]?.data ?? new Uint8Array();
    expect(exifOrientation(exif)).toBe(6);
    expect(ifd0Tags(exif.subarray(6))).toEqual([0x0112]);
    expect(exif.length).toBe(6 + 26);
    expect(await dimensionsOf(out.bytes)).toBeDefined();
  });

  it("leaves a JPEG without metadata byte for byte", () => {
    expect(strip(JPEG_800X600).bytes).toEqual(JPEG_800X600);
  });

  it("drops an orientation of 1, which changes nothing", () => {
    const out = strip(jpegWithMetadata(1));
    expect(out.orientation).toBeUndefined();
    expect(jpegSegments(out.bytes).map((segment) => segment.marker)).not.toContain(0xe1);
  });

  it("keeps a file that ends inside the scan, and refuses one that ends before it", () => {
    const input = jpegWithMetadata(3);
    const truncated = strip(input.subarray(0, input.length - 400));
    expectNoSecrets(truncated.bytes);
    expect(truncated.orientation).toBe(3);

    expect(malformedReason(input.subarray(0, 200))).toBe("a segment runs past the end");
    expect(malformedReason(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeUndefined();
    expect(malformedReason(Uint8Array.of(0xff, 0xd8, 0xff))).toBe("ends inside a marker");
    expect(malformedReason(Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01))).toBe(
      "a segment runs past the end",
    );
    expect(malformedReason(Uint8Array.of(0xff, 0xd8, 0xff, 0xdb, 0x00, 0x02, 0x12))).toBe(
      "expected a marker",
    );
  });
});

describe("ImageMetadata.strip: PNG", () => {
  it("drops text, time and EXIF chunks, and keeps the colour chunks", async () => {
    const out = strip(pngWithMetadata());

    expect(out.format).toBe("png");
    expectNoSecrets(out.bytes);
    const types = pngChunks(out.bytes).map((chunk) => chunk.type);
    expect(types).toEqual(
      pngChunks(PNG_40X30).flatMap((chunk) =>
        chunk.type === "IHDR" ? ["IHDR", "sRGB", "gAMA"] : [chunk.type],
      ),
    );
    expect((await decodePng(out.bytes, 10_000))?.width).toBe(40);
    expect(await dimensionsOf(out.bytes)).toEqual({ width: 40, height: 30 });
  });

  it("keeps only the orientation in a new eXIf chunk", async () => {
    const out = strip(pngWithMetadata(8));

    expect(out.orientation).toBe(8);
    expectNoSecrets(out.bytes);
    const exif = pngChunks(out.bytes).filter((chunk) => chunk.type === "eXIf");
    expect(exif).toHaveLength(1);
    expect(ifd0Tags(exif[0]?.data ?? new Uint8Array())).toEqual([0x0112]);
    // libpng checks the new chunk's CRC.
    expect(await dimensionsOf(out.bytes)).toBeDefined();
  });

  it("leaves a PNG without metadata byte for byte", () => {
    expect(strip(PNG_40X30).bytes).toEqual(PNG_40X30);
  });

  it("refuses a PNG without IEND, with a chunk past the end, or not starting with IHDR", () => {
    const input = pngWithMetadata();
    expect(malformedReason(PNG_40X30.subarray(0, PNG_40X30.length - 12))).toBe("ends before IEND");
    expect(malformedReason(input.subarray(0, 60))).toBe("a chunk runs past the end");
    const noHeader = Uint8Array.from([...PNG_40X30.subarray(0, 8), ...PNG_40X30.subarray(33)]);
    expect(malformedReason(noHeader)).toBe("does not start with IHDR");
  });
});

describe("ImageMetadata.strip: WebP", () => {
  it("drops EXIF, XMP and unknown chunks and fixes the VP8X flags and RIFF size", async () => {
    const out = strip(webpWithMetadata());

    expect(out.format).toBe("webp");
    expectNoSecrets(out.bytes);
    const chunks = webpChunks(out.bytes);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["VP8X", "ICCP", "VP8 "]);
    expect(chunks[0]?.data[0]).toBe(0x20);
    expect(chunks[1]?.data).toEqual(SRGB_ICC);
    const view = new DataView(out.bytes.buffer, out.bytes.byteOffset, out.bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(out.bytes.length - 8);
    expect(await dimensionsOf(out.bytes)).toEqual({ width: 8, height: 6 });
  });

  it("keeps only the orientation in a new EXIF chunk and says so in VP8X", async () => {
    const out = strip(webpWithMetadata(5));

    expect(out.orientation).toBe(5);
    expectNoSecrets(out.bytes);
    const chunks = webpChunks(out.bytes);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["VP8X", "ICCP", "VP8 ", "EXIF"]);
    expect(chunks[0]?.data[0]).toBe(0x28);
    expect(ifd0Tags(chunks[3]?.data ?? new Uint8Array())).toEqual([0x0112]);
    expect(await dimensionsOf(out.bytes)).toBeDefined();
  });

  it("leaves a simple WebP byte for byte", () => {
    expect(strip(WEBP_8X6).bytes).toEqual(WEBP_8X6);
  });

  it("refuses a RIFF size past the end and a file without image data", () => {
    const input = webpWithMetadata();
    expect(malformedReason(input.subarray(0, input.length - 1))).toBe(
      "the RIFF size runs past the end",
    );
    const empty = Uint8Array.from([...WEBP_8X6.subarray(0, 12)]);
    new DataView(empty.buffer).setUint32(4, 4, true);
    expect(malformedReason(empty)).toBe("has no image data");
  });
});

describe("ImageMetadata.strip: AVIF", () => {
  it("blanks the EXIF and XMP items in place and stays readable", async () => {
    expect(containsText(AVIF_8X6_WITH_METADATA, "secret-xmp")).toBe(true);
    expect(containsText(AVIF_8X6_WITH_METADATA, "secret-copyright")).toBe(true);

    const out = strip(AVIF_8X6_WITH_METADATA);

    expect(out.format).toBe("avif");
    expect(out.orientation).toBeUndefined();
    expectNoSecrets(out.bytes);
    expect(containsText(out.bytes, "GPS")).toBe(false);
    expect(out.bytes.length).toBe(AVIF_8X6_WITH_METADATA.length);
    expect(await dimensionsOf(out.bytes)).toEqual({ width: 8, height: 6 });
  });

  it("refuses an AVIF whose boxes do not fit", () => {
    expect(malformedReason(AVIF_8X6_WITH_METADATA.subarray(0, 300))).toBe(
      "the boxes do not fit the file",
    );
  });
});

describe("ImageMetadata.strip: damaged input", () => {
  const fixtures = [
    jpegWithMetadata(6),
    pngWithMetadata(6),
    webpWithMetadata(6),
    AVIF_8X6_WITH_METADATA,
  ];

  it("never throws and never passes on metadata for any truncation", () => {
    for (const input of fixtures) {
      for (let length = 0; length <= input.length; length += 7) {
        const result = ImageMetadata.strip(input.subarray(0, length));
        if (result.isOk() && result.value.kind === "Stripped") {
          expectNoSecrets(result.value.bytes);
        }
      }
    }
  });

  it("never throws on corrupted bytes", () => {
    // A fixed linear congruential sequence, so a failure reproduces.
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed;
    };
    for (const input of fixtures) {
      for (let round = 0; round < 200; round++) {
        const corrupted = input.slice();
        for (let flips = 0; flips < 4; flips++) {
          corrupted[next() % corrupted.length] = next() % 256;
        }
        expect(() => ImageMetadata.strip(corrupted)).not.toThrow();
      }
    }
  });

  it("calls other bytes an unknown format", () => {
    for (const bytes of [new Uint8Array(), Uint8Array.of(1, 2, 3), Uint8Array.of(71, 73, 70, 56)]) {
      expect(
        ImageMetadata.strip(bytes).isOk() && ImageMetadata.strip(bytes)._unsafeUnwrap(),
      ).toEqual({
        kind: "UnknownFormat",
      });
    }
  });
});

describe("ImageMetadata.forUpload", () => {
  it("strips by the bytes whatever the declared type", () => {
    const stored = ImageMetadata.forUpload("image/gif", jpegWithMetadata());
    expect(stored.isOk()).toBe(true);
    expectNoSecrets(stored._unsafeUnwrap());
  });

  it("passes GIF and video through and refuses a declared image it cannot read", () => {
    const gif = Uint8Array.of(71, 73, 70, 56, 57, 97);
    expect(ImageMetadata.forUpload("image/gif", gif)._unsafeUnwrap()).toBe(gif);
    expect(ImageMetadata.forUpload("image/png", Uint8Array.of(1, 2, 3))._unsafeUnwrapErr()).toEqual(
      {
        kind: "NotTheDeclaredType",
        contentType: "image/png",
      },
    );
    expect(ImageMetadata.forUpload("image/jpeg", jpegWithMetadata().subarray(0, 100)).isErr()).toBe(
      true,
    );
  });
});

describe("exifOrientation", () => {
  it("reads the tag in either byte order, with or without the Exif header", () => {
    expect(exifOrientation(exifWithGps(6))).toBe(6);
    expect(exifOrientation(exifWithGps(7))).toBe(7);
    expect(exifOrientation(exifWithGps())).toBeUndefined();
    expect(exifOrientation(exifWithGps(1))).toBeUndefined();
    expect(exifOrientation(exifWithGps(9))).toBeUndefined();
    const app1 = jpegSegments(strip(jpegWithMetadata(2)).bytes).find((s) => s.marker === 0xe1);
    expect(exifOrientation(app1?.data ?? new Uint8Array())).toBe(2);
    expect(
      exifOrientation(Uint8Array.of(0x4d, 0x4d, 0, 42, 0xff, 0xff, 0xff, 0xff)),
    ).toBeUndefined();
  });
});
