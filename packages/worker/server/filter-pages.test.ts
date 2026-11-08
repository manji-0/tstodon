import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { accessTokenFor } from "../test/auth-fixture";
import { type Browser, ORIGIN, postForm, read, signUp } from "../test/passkey-browser";

const page = async (response: Response, status = 200): Promise<string> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
};

const ApiFilterSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  context: z.array(z.string()),
  expires_at: z.string().nullable(),
  filter_action: z.string(),
  statuses: z.array(z.object({ id: z.string(), status_id: z.string() })),
  keywords: z.array(
    z.object({ id: z.string().min(1), keyword: z.string(), whole_word: z.boolean() }),
  ),
});

const AccountSchema = z.object({ id: z.string().min(1) });

/** The signed-up account's bearer headers, to read what the pages saved through the API. */
const apiHeaders = async (username: string): Promise<Record<string, string>> => {
  const lookup = await SELF.fetch(`${ORIGIN}/api/v1/accounts/lookup?acct=${username}`);
  const account = read(AccountSchema, await lookup.json());
  return { Authorization: `Bearer ${await accessTokenFor(account.id)}` };
};

const apiFilters = async (headers: Record<string, string>) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v2/filters`, { headers });
  expect(response.status).toBe(200);
  return read(z.array(ApiFilterSchema), await response.json());
};

const SAVE = {
  title: "Spoilers",
  expires_in: "never",
  context_home: "1",
  context_public: "1",
  filter_action: "warn",
  keyword_0: "finale",
  keyword_0_whole_word: "1",
  keyword_1: "season two",
};

const created = async (fetcher: Browser, fields: Record<string, string> = SAVE) => {
  const response = await postForm(fetcher, "/filters", fields);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/filters?notice=created");
};

const idOf = async (headers: Record<string, string>, title: string): Promise<string> => {
  const found = (await apiFilters(headers)).find((filter) => filter.title === title);
  if (found === undefined) {
    throw new Error(`no filter titled ${title}`);
  }
  return found.id;
};

describe("filter pages", () => {
  it("sends a signed-out browser to sign in, back to the page it asked for", async () => {
    for (const path of ["/filters", "/filters/new", "/filters/1/edit"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(
        `/auth/sign_in?return_to=${encodeURIComponent(path)}`,
      );
    }
  });

  it("creates a filter with keywords that the filters API then reports", async () => {
    const { fetcher } = await signUp("filters_create");
    const empty = await page(await fetcher("/filters"));
    expect(empty).toContain("You have no filters yet.");
    expect(empty).toContain('href="/filters/new"');
    const form = await page(await fetcher("/filters/new"));
    expect(form).toContain('name="title"');
    expect(form).toContain('name="context_thread"');
    expect(form).toContain('<option value="604800">1 week</option>');

    await created(fetcher);
    const filters = await apiFilters(await apiHeaders("filters_create"));
    expect(filters).toHaveLength(1);
    expect(filters[0]).toMatchObject({
      title: "Spoilers",
      context: ["home", "public"],
      expires_at: null,
      filter_action: "warn",
    });
    expect(filters[0]?.keywords.map(({ keyword, whole_word }) => [keyword, whole_word])).toEqual([
      ["finale", true],
      ["season two", false],
    ]);

    const list = await page(await fetcher("/filters?notice=created"));
    expect(list).toContain("Filter created.");
    expect(list).toContain("<strong>Spoilers</strong>");
    expect(list).toContain("Home and lists, Public timelines");
    expect(list).toContain("2 keywords");
    expect(list).toContain(`href="/filters/${filters[0]?.id}/edit"`);
  });

  it("sets the expiry and the hide action", async () => {
    const { fetcher } = await signUp("filters_expiry");
    await created(fetcher, { ...SAVE, expires_in: "3600", filter_action: "hide" });
    const [filter] = await apiFilters(await apiHeaders("filters_expiry"));
    expect(filter?.filter_action).toBe("hide");
    const seconds = Date.parse(filter?.expires_at ?? "") - Date.now();
    expect(seconds).toBeGreaterThan(3500 * 1000);
    expect(seconds).toBeLessThanOrEqual(3600 * 1000);
  });

  it("shows a filter in its edit form and saves changes to it", async () => {
    const { fetcher } = await signUp("filters_edit");
    const headers = await apiHeaders("filters_edit");
    await created(fetcher, { ...SAVE, expires_in: "3600" });
    const id = await idOf(headers, "Spoilers");
    const [before] = await apiFilters(headers);
    const finale = before?.keywords[0];

    const form = await page(await fetcher(`/filters/${id}/edit`));
    expect(form).toContain('value="Spoilers"');
    expect(form).toContain('value="finale"');
    expect(form).toMatch(/id="context_home" name="context_home" value="1" checked/);
    expect(form).not.toMatch(/id="context_thread" name="context_thread" value="1" checked/);
    expect(form).toContain('<option value="keep" selected>');

    const saved = await postForm(fetcher, `/filters/${id}/edit`, {
      title: "Spoilers and more",
      expires_in: "keep",
      context_notifications: "1",
      context_thread: "1",
      filter_action: "hide",
      keyword_0: "finale",
      keyword_0_id: finale?.id ?? "",
      keyword_0_remove: "1",
      keyword_1: "season two",
      keyword_1_id: before?.keywords[1]?.id ?? "",
      keyword_2: "reveal",
      keyword_2_whole_word: "1",
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/filters?notice=updated");

    const [after] = await apiFilters(headers);
    expect(after).toMatchObject({
      id,
      title: "Spoilers and more",
      context: ["notifications", "thread"],
      filter_action: "hide",
      expires_at: before?.expires_at,
    });
    expect(after?.keywords.map(({ keyword, whole_word }) => [keyword, whole_word])).toEqual([
      ["season two", false],
      ["reveal", true],
    ]);
    expect(after?.keywords[0]?.id).toBe(before?.keywords[1]?.id);
  });

  it("drops a post a filter was narrowed to", async () => {
    const { fetcher } = await signUp("filters_status");
    const headers = await apiHeaders("filters_status");
    await created(fetcher);
    const id = await idOf(headers, "Spoilers");
    const post = await SELF.fetch(`${ORIGIN}/api/v1/statuses`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "a post to hide" }),
    });
    const status = read(z.object({ id: z.string().min(1) }), await post.json());
    const attached = await SELF.fetch(`${ORIGIN}/api/v2/filters/${id}/statuses`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ status_id: status.id }),
    });
    expect(attached.status).toBe(200);
    const [filter] = await apiFilters(headers);
    const entry = filter?.statuses[0];
    expect(entry?.status_id).toBe(status.id);

    expect(await page(await fetcher(`/filters/${id}/edit`))).toContain(
      `name="remove_status_${entry?.id}"`,
    );
    expect(await page(await fetcher("/filters"))).toContain("1 post");
    const saved = await postForm(fetcher, `/filters/${id}/edit`, {
      ...SAVE,
      [`remove_status_${entry?.id}`]: "1",
    });
    expect(saved.status).toBe(303);
    expect((await apiFilters(headers))[0]?.statuses).toEqual([]);
  });

  it("deletes a filter", async () => {
    const { fetcher } = await signUp("filters_delete");
    const headers = await apiHeaders("filters_delete");
    await created(fetcher);
    const id = await idOf(headers, "Spoilers");

    const deleted = await postForm(fetcher, `/filters/${id}/delete`, {});
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get("location")).toBe("/filters?notice=deleted");
    expect(await apiFilters(headers)).toEqual([]);
    await page(await postForm(fetcher, `/filters/${id}/delete`, {}), 404);
  });

  it("lists only the signed-in account's filters and answers 404 for another's", async () => {
    const { fetcher: owner } = await signUp("filters_owner");
    const { fetcher: other } = await signUp("filters_other");
    await created(owner, { ...SAVE, title: "Owner only" });
    await created(other, { ...SAVE, title: "Other only" });
    const id = await idOf(await apiHeaders("filters_owner"), "Owner only");

    const list = await page(await other("/filters"));
    expect(list).toContain("Other only");
    expect(list).not.toContain("Owner only");
    await page(await other(`/filters/${id}/edit`), 404);
    await page(await postForm(other, `/filters/${id}/edit`, SAVE), 404);
    await page(await postForm(other, `/filters/${id}/delete`, {}), 404);
    expect((await apiFilters(await apiHeaders("filters_owner")))[0]?.title).toBe("Owner only");
  });

  it("refuses a filter form posted from another site", async () => {
    const { fetcher } = await signUp("filters_cross_site");
    const crossSite = await fetcher("/filters", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams(SAVE).toString(),
    });
    expect(crossSite.status).toBe(403);
    expect(await apiFilters(await apiHeaders("filters_cross_site"))).toEqual([]);
  });

  it("shows what is wrong with a filter form and keeps what was typed", async () => {
    const { fetcher } = await signUp("filters_invalid");
    for (const [fields, message] of [
      [{ ...SAVE, title: "  " }, "Enter a title."],
      [{ ...SAVE, context_home: "", context_public: "" }, "Choose at least one place"],
      [{ ...SAVE, keyword_0: "", keyword_1: "" }, "Add at least one keyword."],
      [{ ...SAVE, expires_in: "42" }, "Choose when the filter expires"],
    ] as const) {
      const html = await page(await postForm(fetcher, "/filters", fields), 422);
      expect(html).toContain(message);
    }
    const retained = await page(
      await postForm(fetcher, "/filters", {
        ...SAVE,
        title: "Kept <b>",
        context_home: "",
        context_public: "",
      }),
      422,
    );
    expect(retained).toContain('value="Kept &lt;b&gt;"');
    expect(retained).toContain('value="season two"');
    expect(await apiFilters(await apiHeaders("filters_invalid"))).toEqual([]);
  });
});
