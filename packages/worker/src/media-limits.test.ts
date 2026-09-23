import { describe, expect, it } from "vitest";
import { validateMediaUpload, normalizeMediaContentType } from "./media-limits";

describe("media-limits", () => {
  it("accepts supported image MIME types under the size cap", () => {
    expect(validateMediaUpload("image/png", 1024)).toBeUndefined();
    expect(validateMediaUpload("image/jpeg", 1024)).toBeUndefined();
    expect(validateMediaUpload("image/webp", 1024)).toBeUndefined();
    expect(normalizeMediaContentType("image/jpg")).toBe("image/jpeg");
  });

  it("rejects unsupported types, empty files, and oversized uploads", () => {
    expect(validateMediaUpload("text/plain", 10)?.kind).toBe("ValidationError");
    expect(validateMediaUpload("image/png", 0)?.kind).toBe("ValidationError");
    expect(validateMediaUpload("image/png", 9 * 1024 * 1024)?.kind).toBe("ValidationError");
  });
});
