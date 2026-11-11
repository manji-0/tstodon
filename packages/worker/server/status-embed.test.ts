import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiOEmbed, ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

const ORIGIN = "https://example.com";

const get = (path: string, init?: RequestInit) => SELF.fetch(`${ORIGIN}${path}`, init);

const post = async (
  email: string,
  visibility: "public" | "unlisted" | "private" | "direct",
): Promise<string> => {
  const response = await get("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: `a ${visibility} post`, visibility }),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, await response.json()).id;
};

const oembed = (url: string, extra = "") =>
  get(`/api/oembed?url=${encodeURIComponent(url)}${extra}`);

const suspend = async (accountId: string) => {
  const response = await get(`/api/v1/admin/accounts/${accountId}/suspend`, {
    method: "POST",
    headers: await authHeaders("embed-admin@example.com", { admin: true }),
  });
  expect(response.status).toBe(200);
};

describe("status embeds", () => {
  it("answers oEmbed for a public status, by either of its URLs", async () => {
    const author = await signedInAccount("embed-author@example.com");
    const id = await post("embed-author@example.com", "public");
    const page = `${ORIGIN}/@${author.username}/${id}`;

    const response = await oembed(page);
    expect(response.status).toBe(200);
    const document = expectContract(ApiOEmbed, await response.json());
    expect(document).toMatchObject({
      type: "rich",
      version: "1.0",
      author_name: author.username,
      author_url: `${ORIGIN}/@${author.username}`,
      provider_name: "example.com",
      provider_url: `${ORIGIN}/`,
      cache_age: 86400,
      width: 400,
      height: null,
    });
    expect(document.html).toContain(
      `<blockquote class="mastodon-embed" data-embed-url="${page}/embed"`,
    );
    expect(document.html).toContain(`<a href="${page}" target="_blank"`);
    expect(document.html).toContain(`Post by @${author.username}@example.com`);
    expect(document.html).toContain(
      `<script data-allowed-prefixes="${ORIGIN}/" async src="${ORIGIN}/embed.js"></script>`,
    );

    const byUri = await oembed(
      `${ORIGIN}/users/${author.username}/statuses/${id}`,
      "&maxwidth=300&maxheight=200",
    );
    expect(byUri.status).toBe(200);
    expect(expectContract(ApiOEmbed, await byUri.json())).toMatchObject({
      html: document.html,
      width: 300,
      height: 200,
    });
  });

  it("embeds public and unlisted statuses only, of their own author, on this server", async () => {
    const author = await signedInAccount("embed-vis@example.com");
    const other = await signedInAccount("embed-vis-other@example.com");
    const page = (id: string) => `${ORIGIN}/@${author.username}/${id}`;

    expect((await oembed(page(await post("embed-vis@example.com", "unlisted")))).status).toBe(200);
    expect((await oembed(page(await post("embed-vis@example.com", "private")))).status).toBe(404);
    expect((await oembed(page(await post("embed-vis@example.com", "direct")))).status).toBe(404);

    const id = await post("embed-vis@example.com", "public");
    expect((await oembed(`${ORIGIN}/@${other.username}/${id}`)).status).toBe(404);
    expect((await oembed(`https://elsewhere.example/@${author.username}/${id}`)).status).toBe(404);
    expect((await oembed(`${ORIGIN}/@${author.username}/${id}/embed`)).status).toBe(404);
    expect((await get("/api/oembed")).status).toBe(404);
    expect((await oembed("not a url")).status).toBe(404);
  });

  it("gives the web UI's Embed dialog the oEmbed document of a status the viewer may see", async () => {
    const author = await signedInAccount("embed-web@example.com");
    const id = await post("embed-web@example.com", "public");

    const response = await get(`/api/web/embeds/${id}`, {
      headers: await authHeaders("embed-web-viewer@example.com"),
    });
    expect(response.status).toBe(200);
    const document = expectContract(ApiOEmbed, await response.json());
    expect(document.html).toContain(`data-embed-url="${ORIGIN}/@${author.username}/${id}/embed"`);
    expect((await get(`/api/web/embeds/${id}`)).status).toBe(200);

    const hidden = await post("embed-web@example.com", "private");
    expect(
      (
        await get(`/api/web/embeds/${hidden}`, {
          headers: await authHeaders("embed-web@example.com"),
        })
      ).status,
    ).toBe(404);
    expect((await get("/api/web/embeds/1")).status).toBe(404);

    const boost = await get(`/api/v1/statuses/${id}/reblog`, {
      method: "POST",
      headers: await authHeaders("embed-web-viewer@example.com"),
    });
    expect(boost.status).toBe(200);
    const boostId = expectContract(ApiStatus, await boost.json()).id;
    expect(boostId).not.toBe(id);
    expect((await get(`/api/web/embeds/${boostId}`)).status).toBe(404);
  });

  it("serves the embed page any site may frame, and embed.js", async () => {
    const author = await signedInAccount("embed-page@example.com");
    const id = await post("embed-page@example.com", "public");

    const response = await get(`/@${author.username}/${id}/embed`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("public, max-age=180");
    const html = await response.text();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<body class="embed">');
    expect(html).toContain(
      `<div id="mastodon-status" data-props="{&quot;locale&quot;:&quot;en&quot;,&quot;id&quot;:&quot;${id}&quot;}">`,
    );
    expect(html).toContain('"access_token":null');
    const pack = /<script type="module" src="(\/packs\/embed-[^"]+\.js)"/.exec(html)?.[1];
    expect(pack).toBeDefined();
    expect((await get(pack ?? "")).status).toBe(200);

    const hidden = await post("embed-page@example.com", "private");
    expect((await get(`/@${author.username}/${hidden}/embed`)).status).toBe(404);

    const script = await get("/embed.js");
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("blockquote.mastodon-embed");
  });

  it("advertises the oEmbed endpoint on an embeddable status's page", async () => {
    const author = await signedInAccount("embed-link@example.com");
    const id = await post("embed-link@example.com", "public");
    const html = await (await get(`/@${author.username}/${id}`)).text();
    const href = new URLSearchParams({
      url: `${ORIGIN}/@${author.username}/${id}`,
      format: "json",
    });
    expect(html).toContain(
      `<link rel="alternate" type="application/json+oembed" href="${ORIGIN}/api/oembed?${href.toString().replaceAll("&", "&amp;")}">`,
    );

    const hidden = await post("embed-link@example.com", "private");
    expect(await (await get(`/@${author.username}/${hidden}`)).text()).not.toContain(
      "application/json+oembed",
    );
  });

  it("embeds nothing of a suspended account", async () => {
    const author = await signedInAccount("embed-suspended@example.com");
    const id = await post("embed-suspended@example.com", "public");
    await suspend(author.id);

    expect((await oembed(`${ORIGIN}/@${author.username}/${id}`)).status).toBe(404);
    expect((await get(`/api/web/embeds/${id}`)).status).toBe(404);
    expect((await get(`/@${author.username}/${id}/embed`)).status).toBe(404);
  });
});
