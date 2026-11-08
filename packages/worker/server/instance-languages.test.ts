import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";

const LanguageListSchema = z.array(z.object({ code: z.string().length(2), name: z.string() }));

describe("instance languages", () => {
  it("lists ISO 639-1 languages without authentication", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/instance/languages");
    expect(response.status).toBe(200);
    const parsed = schemaResult(LanguageListSchema)(await response.json());
    expect(parsed.isOk()).toBe(true);
    if (parsed.isErr()) {
      throw new Error("response schema rejected");
    }
    const languages = parsed.value;
    expect(languages).toContainEqual({ code: "en", name: "English" });
    expect(languages).toContainEqual({ code: "ja", name: "Japanese" });
    expect(new Set(languages.map((language) => language.code)).size).toBe(languages.length);
  });
});
