import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { WebFingerJrd } from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { PNG_40X30 } from "../test/image-fixtures";

/**
 * `/.well-known/webfinger` as Mastodon v4.7.5's `WebfingerController`,
 * `WebfingerResource` and `WebfingerSerializer`: every resource form it
 * resolves, the links it serves, and its 400 / 404 / 410 answers.
 */

const ORIGIN = "https://example.com";

const webfinger = (resource?: string) =>
  SELF.fetch(
    `${ORIGIN}/.well-known/webfinger${
      resource === undefined ? "" : `?resource=${encodeURIComponent(resource)}`
    }`,
  );

const jrd = async (resource: string) => {
  const response = await webfinger(resource);
  expect(response.status, resource).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/jrd+json");
  expect(response.headers.get("cache-control")).toBe("max-age=259200, public");
  return expectContract(WebFingerJrd, await response.json());
};

/** The links Mastodon serves for every account, the instance actor included. */
const interactionLinks = [
  {
    rel: "http://ostatus.org/schema/1.0/subscribe",
    template: `${ORIGIN}/authorize_interaction?uri={uri}`,
  },
  { rel: "https://w3id.org/fep/3b86/Create", template: `${ORIGIN}/share?text={content}` },
  {
    rel: "https://w3id.org/fep/3b86/Object",
    template: `${ORIGIN}/authorize_interaction?uri={object}`,
  },
];

describe("WebFinger for a local account", () => {
  it("names the profile page and the actor, and the interaction templates", async () => {
    const account = await signedInAccount("wf-links@example.com");
    const profile = `${ORIGIN}/@${account.username}`;
    const actor = `${ORIGIN}/users/${account.username}`;
    expect(await jrd(`acct:${account.username}@example.com`)).toEqual({
      subject: `acct:${account.username}@example.com`,
      aliases: [profile, actor],
      links: [
        { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: profile },
        { rel: "self", type: "application/activity+json", href: actor },
        ...interactionLinks,
      ],
    });
  });

  it("links the avatar once the account has one", async () => {
    const email = "wf-avatar@example.com";
    const account = await signedInAccount(email);
    const form = new FormData();
    form.set("avatar", new File([PNG_40X30], "avatar.png", { type: "image/png" }));
    const updated = await SELF.fetch(`${ORIGIN}/api/v1/accounts/update_credentials`, {
      method: "PATCH",
      headers: await authHeaders(email),
      body: form,
    });
    expect(updated.status).toBe(200);
    const { links } = await jrd(`acct:${account.username}@example.com`);
    const avatar = links.find((link) => link.rel === "http://webfinger.net/rel/avatar");
    expect(avatar).toMatchObject({ type: "image/png" });
    expect(avatar?.href).toMatch(/\/avatars\//);
    expect(links.at(-1)).toEqual(avatar);
  });

  it("answers the same document for every form Mastodon resolves", async () => {
    const account = await signedInAccount("wf-forms@example.com");
    const expected = await jrd(`acct:${account.username}@example.com`);
    for (const resource of [
      `${account.username}@example.com`,
      `acct:${account.username.toUpperCase()}@EXAMPLE.COM`,
      `${ORIGIN}/users/${account.username}`,
      `${ORIGIN}/@${account.username}`,
      `${ORIGIN}/@${account.username}/`,
    ]) {
      expect(await jrd(resource), resource).toEqual(expected);
    }
  });
});

describe("WebFinger for the instance actor", () => {
  it("answers acct:<domain>@<domain>, the bare domain, the site URL and the actor URL", async () => {
    const expected = {
      subject: "acct:example.com@example.com",
      aliases: [`${ORIGIN}/actor`],
      links: [
        {
          rel: "http://webfinger.net/rel/profile-page",
          type: "text/html",
          href: `${ORIGIN}/about/more?instance_actor=true`,
        },
        { rel: "self", type: "application/activity+json", href: `${ORIGIN}/actor` },
        ...interactionLinks,
      ],
    };
    for (const resource of [
      "acct:example.com@example.com",
      "example.com@example.com",
      "example.com",
      "example.com/",
      ORIGIN,
      `${ORIGIN}/`,
      `${ORIGIN}/actor`,
    ]) {
      expect(await jrd(resource), resource).toEqual(expected);
    }
  });

  it("sends the instance actor's profile page to the about page", async () => {
    const response = await SELF.fetch(`${ORIGIN}/about/more?instance_actor=true`, {
      redirect: "manual",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/about");
  });
});

describe("WebFinger errors", () => {
  const status = async (resource?: string) => {
    const response = await webfinger(resource);
    expect(await response.text(), resource).toBe("");
    expect(response.headers.get("cache-control"), resource).toBe("max-age=180, public");
    return response.status;
  };

  it("answers 400 for a missing resource or one that is neither a URL nor a handle", async () => {
    expect(await status()).toBe(400);
    expect(await status("")).toBe(400);
    expect(await status("nobody")).toBe(400);
    expect(await status("acct:nobody")).toBe(400);
  });

  it("answers 404 for what names no local account", async () => {
    const account = await signedInAccount("wf-missing@example.com");
    expect(await status("acct:wf_never_existed@example.com")).toBe(404);
    expect(await status(`acct:${account.username}@other.example`)).toBe(404);
    expect(await status(`${account.username}@`)).toBe(404);
    expect(await status(`${ORIGIN}/tags/webfinger`)).toBe(404);
    expect(await status(`${ORIGIN}/users/${account.username}/statuses/1`)).toBe(404);
    expect(await status(`https://other.example/@${account.username}`)).toBe(404);
  });

  it("answers 410 for a deleted account", async () => {
    const account = await signedInAccount("wf-deleted@example.com");
    const deleted = await SELF.fetch(`${ORIGIN}/api/v1/admin/accounts/${account.id}`, {
      method: "DELETE",
      headers: await authHeaders("wf-deleter@example.com", { admin: true }),
    });
    expect(deleted.status).toBe(200);
    expect(await status(`acct:${account.username}@example.com`)).toBe(410);
    expect(await status(`${ORIGIN}/@${account.username}`)).toBe(410);
  });
});
