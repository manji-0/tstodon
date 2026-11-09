import { describe, expect, it } from "vite-plus/test";
import { humanSize } from "./human-size";

describe("humanSize", () => {
  it("writes byte counts as Rails' number_to_human_size does", () => {
    expect(humanSize(0)).toBe("0 Bytes");
    expect(humanSize(1)).toBe("1 Byte");
    expect(humanSize(1023)).toBe("1023 Bytes");
    expect(humanSize(1024)).toBe("1 KB");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(1_234_567)).toBe("1.18 MB");
    expect(humanSize(123_456_789)).toBe("118 MB");
    expect(humanSize(5 * 1024 ** 3)).toBe("5 GB");
  });
});
