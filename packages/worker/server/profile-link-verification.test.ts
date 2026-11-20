import { SELF, env } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { ApiAccount, ApiCredentialAccount } from "@tstodon/api";
import type { OutboxJob } from "@tstodon/domain";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { queueCapturingEnv } from "../test/queue-capture";
import { remoteActor } from "../test/remote-actor-fixture";
import { processOutboxJob } from "./outbox-job";
import {
  queueDueProfileLinkChecks,
  queueProfileLinkCheck,
  remoteFieldLink,
} from "./profile-link-verification";
import { RemoteAccountId } from "./remote-account-id";

type Page = Readonly<{ status?: number; html?: string; location?: string }>;

/** Answer the fetches of `pages` (GET and HEAD) while the test runs; the URLs fetched, in order. */
const servePages = (pages: Readonly<Record<string, Page>>): { fetched: string[] } => {
  const fetched: string[] = [];
  const original = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const page = pages[href];
      if (page === undefined) {
        return original(input, init);
      }
      fetched.push(`${init?.method ?? "GET"} ${href}`);
      return new Response(page.html ?? "", {
        status: page.status ?? 200,
        headers: {
          "content-type": "text/html",
          ...(page.location ? { location: page.location } : {}),
        },
      });
    });
  onTestFinished(() => spy.mockRestore());
  return { fetched };
};

const linkingTo = (href: string, tag: "a" | "link" = "a", rel = "me") =>
  tag === "a"
    ? `<html><body><a rel="${rel}" href="${href}">me</a></body></html>`
    : `<html><head><link rel="${rel}" href="${href}"></head></html>`;

const updateFields = async (email: string, fields: ReadonlyArray<[string, string]>) => {
  const response = await SELF.fetch("https://example.com/api/v1/accounts/update_credentials", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ fields_attributes: fields.map(([name, value]) => ({ name, value })) }),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiCredentialAccount, await response.json());
};

const verifyCredentials = async (email: string) => {
  const response = await SELF.fetch("https://example.com/api/v1/accounts/verify_credentials", {
    headers: await authHeaders(email),
  });
  return expectContract(ApiCredentialAccount, await response.json());
};

const verifyJob = (account: Extract<OutboxJob, { kind: "VerifyProfileLinks" }>["account"]) =>
  processOutboxJob(env, { kind: "VerifyProfileLinks", account, fromIndex: 0 });

describe("a local account's profile field links", () => {
  it("marks a field verified when its page links back with rel=me, as Mastodon's VerifyLinkService", async () => {
    const email = "links-local@example.com";
    const account = await signedInAccount(email);
    const profile = `https://example.com/@${account.username}`;
    const pages = servePages({
      "https://links-local.example.com/": { html: linkingTo(profile.toUpperCase()) },
      "https://links-local.example.com/elsewhere": { html: linkingTo("https://other.example/@x") },
      "https://other.example/@x": {},
    });
    const updated = await updateFields(email, [
      ["site", "https://links-local.example.com/"],
      ["other", "https://links-local.example.com/elsewhere"],
      ["text", "not a link"],
    ]);
    // The value links its URL with rel="me", as Mastodon renders a local field.
    expect(updated.fields[0]?.value).toContain('rel="nofollow noopener me"');
    expect(updated.fields[0]?.value).toContain('href="https://links-local.example.com/"');
    expect(updated.fields.map((field) => field.verified_at)).toEqual([null, null, null]);

    expect(await verifyJob({ kind: "LocalAccount", accountId: account.id })).toBe("ok");

    const verified = await verifyCredentials(email);
    expect(verified.fields[0]?.verified_at).not.toBeNull();
    expect(verified.fields.slice(1).map((field) => field.verified_at)).toEqual([null, null]);
    expect(verified.source.fields[0]?.verified_at).toBe(verified.fields[0]?.verified_at);
    // The queue may run the job the update queued as well.
    expect(new Set(pages.fetched)).toEqual(
      new Set([
        "GET https://links-local.example.com/",
        "GET https://links-local.example.com/elsewhere",
        // Its only rel=me link may redirect to the profile.
        "HEAD https://other.example/@x",
      ]),
    );
  });

  it("keeps a verified field that stays and checks a changed one again, as Mastodon's fields_attributes=", async () => {
    const email = "links-local-change@example.com";
    const account = await signedInAccount(email);
    const profile = `https://example.com/@${account.username}`;
    servePages({ "https://links-change.example/": { html: linkingTo(profile) } });
    await updateFields(email, [["site", "https://links-change.example/"]]);
    await verifyJob({ kind: "LocalAccount", accountId: account.id });

    const renamed = await updateFields(email, [
      ["web", "https://links-change.example/"],
      ["new", "https://links-new.example/"],
    ]);
    expect(renamed.fields[0]?.verified_at).not.toBeNull();
    expect(renamed.fields[1]?.verified_at).toBeNull();

    const changed = await updateFields(email, [["web", "https://links-change.example/me"]]);
    expect(changed.fields[0]?.verified_at).toBeNull();
  });

  it("queues the check only when a field waits for one", async () => {
    const sent: OutboxJob[] = [];
    const target = queueCapturingEnv(sent);
    const account = { kind: "LocalAccount", accountId: "1" } as const;
    await queueProfileLinkCheck(target, account, [{ name: "a", value: "http://plain.example" }]);
    expect(sent).toEqual([]);
    await queueProfileLinkCheck(target, account, [{ name: "a", value: "https://tls.example" }]);
    expect(sent).toEqual([{ kind: "VerifyProfileLinks", account, fromIndex: 0 }]);
  });
});

describe("a remote account's profile field links", () => {
  const mastodonLink = (url: string) =>
    `<a href="${url}" target="_blank" rel="nofollow noopener me" translate="no"><span class="invisible">https://</span><span class="">${url.slice(8)}</span><span class="invisible"></span></a>`;

  it("verifies a field whose page links back to the actor's profile URL, or redirects to it", async () => {
    const profileUrl = "https://links-remote.example/@carol";
    const author = await remoteActor("carol", "links-remote.example", {
      profileUrl,
      fields: [
        { name: "site", value: mastodonLink("https://carol-site.example") },
        { name: "short", value: mastodonLink("https://carol-short.example") },
        { name: "none", value: mastodonLink("https://carol-none.example") },
        { name: "gone", value: mastodonLink("https://carol-gone.example") },
        {
          name: "plain",
          value: '<a href="http://carol-http.example">http://carol-http.example</a>',
        },
      ],
    });
    const pages = servePages({
      "https://carol-site.example/": { html: linkingTo(profileUrl, "link", "Me Author") },
      "https://carol-short.example/": { html: linkingTo("https://s.example/c") },
      "https://s.example/c": { status: 301, location: profileUrl },
      "https://carol-none.example/": { html: "<p>no links</p>" },
      "https://carol-gone.example/": { status: 404, html: linkingTo(profileUrl) },
    });

    expect(await verifyJob({ kind: "RemoteActor", actorUri: author.actorUri })).toBe("ok");

    const shown = await SELF.fetch(
      `https://example.com/api/v1/accounts/${RemoteAccountId.encode(author.actorUri)}`,
    );
    const fields = expectContract(ApiAccount, await shown.json()).fields;
    expect(fields.map((field) => field.verified_at !== null)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    // An http link is never fetched.
    expect(pages.fetched.some((entry) => entry.includes("carol-http"))).toBe(false);
  });

  it("queues a check for each actor fetched since its links were looked at", async () => {
    const author = await remoteActor("dora", "links-due.example", {
      fields: [{ name: "site", value: mastodonLink("https://dora.example") }],
    });
    const plain = await remoteActor("erin", "links-due.example", {
      fields: [{ name: "pronouns", value: "she/her" }],
    });
    const sent: OutboxJob[] = [];
    await queueDueProfileLinkChecks(queueCapturingEnv(sent));
    const queuedFor = (uri: string) =>
      sent.filter((job) => job.kind === "VerifyProfileLinks" && JSON.stringify(job).includes(uri))
        .length;
    expect(queuedFor(author.actorUri)).toBe(1);
    expect(queuedFor(plain.actorUri)).toBe(0);

    await queueDueProfileLinkChecks(queueCapturingEnv(sent));
    expect(queuedFor(author.actorUri)).toBe(1);

    // A new fetch of the actor stores its fields unverified again: they are checked again.
    await env.DB.prepare("UPDATE remote_actors SET fetched_at = ? WHERE actor_uri = ?")
      .bind(new Date(Date.now() + 60_000).toISOString(), author.actorUri)
      .run();
    await queueDueProfileLinkChecks(queueCapturingEnv(sent));
    expect(queuedFor(author.actorUri)).toBe(2);
  });
});

describe("remoteFieldLink", () => {
  it.each([
    ['<a href="https://a.example">https://a.example</a>', "https://a.example"],
    [
      '<a href="https://a.example/x" rel="me"><span class="invisible">https://</span><span>a.example/x</span></a>',
      "https://a.example/x",
    ],
    ['<a href="https://a.example">my site</a>', undefined],
    ['see <a href="https://a.example">https://a.example</a>', undefined],
    ['<p><a href="https://a.example">https://a.example</a></p>', undefined],
    ["https://a.example", undefined],
  ])("reads %s as %s", async (html, expected) => {
    expect(await remoteFieldLink(html)).toBe(expected);
  });
});
