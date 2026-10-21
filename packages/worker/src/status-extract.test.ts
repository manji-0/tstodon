import { describe, expect, it } from "vite-plus/test";
import { extractHashtags } from "./status-discovery-store";

describe("status text extractors", () => {
  it("extracts unique lowercase hashtags", () => {
    expect(extractHashtags("Hello #WaveA and #wavea plus #Other")).toEqual(["wavea", "other"]);
  });
});
