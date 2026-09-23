import { describe, expect, it } from "vitest";
import { MediaObjectRef } from "./media-object-ref";

describe("MediaObjectRef", () => {
  it("maps nullish to None and non-empty to Present", () => {
    expect(MediaObjectRef.fromNullable(null)).toEqual(MediaObjectRef.none);
    expect(MediaObjectRef.fromNullable("")).toEqual(MediaObjectRef.none);
    expect(MediaObjectRef.fromNullable("avatars/a/b")).toEqual(
      MediaObjectRef.present("avatars/a/b"),
    );
  });

  it("rejects Present with an empty value", () => {
    const parsed = MediaObjectRef.parse({ kind: "Present", value: "" });
    expect(parsed.isErr()).toBe(true);
  });
});
