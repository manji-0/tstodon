import { SELF } from "cloudflare:test";
import { ApiInitialState } from "@tstodon/api";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders } from "../test/auth-fixture";
import { postForm, signUp } from "../test/passkey-browser";

const ORIGIN = "https://example.com";
const LanguageList = z.array(z.object({ code: z.string(), name: z.string() }));

/**
 * The languages are Mastodon v4.7.5's `LanguagesHelper::SUPPORTED_LOCALES`:
 * ISO 639-1 without `gn` and `sm`, its regional variants, ISO 639-3 and its
 * regional variants, in that order.
 */
describe("instance languages", () => {
  it("lists SUPPORTED_LOCALES with their English names, without authentication", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/instance/languages`);
    expect(response.status).toBe(200);
    const languages = expectContract(LanguageList, await response.json());
    expect(languages).toHaveLength(214);
    expect(languages[0]).toEqual({ code: "aa", name: "Afar" });
    expect(languages.at(-1)).toEqual({ code: "nan-TW", name: "Hokkien (Taiwan)" });
    expect(languages).toContainEqual({ code: "en", name: "English" });
    expect(languages).toContainEqual({ code: "zh-TW", name: "Chinese (Taiwan)" });
    expect(languages).toContainEqual({ code: "tok", name: "Toki Pona" });
    expect(languages.map((language) => language.code)).not.toContain("gn");
    expect(languages.map((language) => language.code)).not.toContain("sm");
    expect(new Set(languages.map((language) => language.code)).size).toBe(languages.length);
  });

  it("gives the web app each language's native name", async () => {
    const page = await SELF.fetch(`${ORIGIN}/`);
    const state = expectContract(
      ApiInitialState,
      JSON.parse(
        /<script id="initial-state" type="application\/json">([^<]*)<\/script>/.exec(
          await page.text(),
        )?.[1] ?? "null",
      ),
    );
    expect(state.languages).toContainEqual(["ja", "Japanese", "日本語"]);
    expect(state.languages).toContainEqual(["zh-YUE", "Cantonese", "廣東話"]);
    expect(state.languages).toHaveLength(214);
  });

  it("takes a default posting language of SUPPORTED_LOCALES as written", async () => {
    const email = "languages-source@example.com";
    const update = async (language: string) =>
      SELF.fetch(`${ORIGIN}/api/v1/accounts/update_credentials`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: JSON.stringify({ source: { language } }),
      });
    const taken = await update("zh-TW");
    expect(taken.status).toBe(200);
    expect(
      z.object({ source: z.object({ language: z.string() }) }).parse(await taken.json()),
    ).toMatchObject({ source: { language: "zh-TW" } });
    for (const refused of ["gn", "sm", "zh-tw", "xx"]) {
      expect((await update(refused)).status, refused).toBe(422);
    }
  });

  it("offers and saves SUPPORTED_LOCALES on the posting defaults page", async () => {
    const { fetcher } = await signUp("languages_prefs");
    const form = await (await fetcher("/settings/preferences/posting_defaults")).text();
    expect(form).toContain('<option value="tok">toki pona</option>');
    expect(form).not.toContain('<option value="gn">');
    const save = (language: string) =>
      postForm(fetcher, "/settings/preferences/posting_defaults", {
        privacy: "public",
        quote_policy: "public",
        language,
      });
    expect((await save("nan-TW")).status).toBe(200);
    expect(await (await fetcher("/settings/preferences/posting_defaults")).text()).toContain(
      '<option value="nan-TW" selected>',
    );
    expect((await save("gn")).status).toBe(422);
  });
});
