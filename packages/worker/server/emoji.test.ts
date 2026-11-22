import { describe, expect, it } from "vite-plus/test";
import { type CustomEmoji, emojisInTexts } from "./emoji";

const configured = (shortcode: string): CustomEmoji => ({
  shortcode,
  url: `https://media.example.com/emoji/${shortcode}.png`,
  static_url: `https://media.example.com/emoji/${shortcode}.png`,
  visible_in_picker: true,
  source: { kind: "Configured" },
});

const wave = configured("wave");
const w = configured("w");

const shortcodes = (texts: ReadonlyArray<string>): ReadonlyArray<string> =>
  emojisInTexts(texts, [wave, w]).map((emoji) => emoji.shortcode);

// Mastodon's `CustomEmoji::SCAN_RE`, which `CustomEmoji.from_text` scans with.
describe("emojisInTexts", () => {
  it("reads a shortcode with no letter, mark, digit or colon on either side", () => {
    expect(shortcodes([":wave:"])).toEqual(["wave"]);
    expect(shortcodes(["(:wave:)"])).toEqual(["wave"]);
    expect(shortcodes(["hi\n:wave:\nbye"])).toEqual(["wave"]);
    expect(shortcodes(["<p>:wave:</p>"])).toEqual(["wave"]);
  });

  it("reads no shortcode glued to a letter, mark, digit or colon", () => {
    expect(shortcodes(["x:wave:"])).toEqual([]);
    expect(shortcodes([":wave:x"])).toEqual([]);
    expect(shortcodes(["1:wave:"])).toEqual([]);
    expect(shortcodes(["é:wave:"])).toEqual([]);
    expect(shortcodes(["é:wave:"])).toEqual([]);
    expect(shortcodes([":wave::"])).toEqual([]);
    expect(shortcodes(["::wave:"])).toEqual([]);
    expect(shortcodes([":wave::wave:"])).toEqual([]);
  });

  it("reads no one-character shortcode", () => {
    expect(shortcodes([":w:"])).toEqual([]);
  });
});
