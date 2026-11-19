import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { ORIGIN, signUp } from "../test/passkey-browser";
import { remoteActor } from "../test/remote-actor-fixture";

/**
 * `/authorize_interaction` as Mastodon v4.7.5's `AuthorizeInteractionsController`
 * (the target of the WebFinger `subscribe` and FEP-3b86 `Object` templates),
 * the routes that redirect to it, and `/intent`.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const post = async (email: string, status: string, visibility = "public") => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/statuses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status, visibility }),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

const interaction = (params: Record<string, string>) =>
  `/authorize_interaction?${new URLSearchParams(params).toString()}`;

/** Serve `documents` by URL to the Worker's outbound fetches while `run` runs. */
const withRemoteDocuments = async <T>(
  documents: Readonly<Record<string, unknown>>,
  run: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents[href];
    return document === undefined
      ? original(input, init)
      : new Response(JSON.stringify(document), {
          headers: { "content-type": "application/activity+json" },
        });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const redirectsTo = async (response: Response, location: string) => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(location);
};

describe("/authorize_interaction signed out", () => {
  it("sends the browser to sign in, then back to the interaction", async () => {
    const path = interaction({ uri: "https://remote.example/@someone/1" });
    const response = await SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual" });
    await redirectsTo(response, `/auth/sign_in?return_to=${encodeURIComponent(path)}`);
  });
});

describe("/authorize_interaction signed in", () => {
  it("opens a local account named by its URL, its handle or acct", async () => {
    const { fetcher } = await signUp("ai_viewer_local");
    const target = await signedInAccount("ai-target@example.com");
    for (const params of [
      { uri: `${ORIGIN}/@${target.username}` },
      { uri: `${ORIGIN}/users/${target.username}` },
      { uri: `${target.username}@example.com` },
      { uri: `@${target.username}@example.com` },
      { acct: `acct:${target.username}@example.com` },
    ]) {
      await redirectsTo(await fetcher(interaction(params)), `/@${target.username}`);
    }
  });

  it("opens a local status named by its URI or its page URL", async () => {
    const { fetcher } = await signUp("ai_viewer_status");
    const email = "ai-author@example.com";
    const author = await signedInAccount(email);
    const status = await post(email, "a local post to interact with");
    for (const uri of [status.uri, status.url ?? ""]) {
      await redirectsTo(await fetcher(interaction({ uri })), `/@${author.username}/${status.id}`);
    }
  });

  it("opens a remote account by its handle and a remote status by its URL", async () => {
    const { fetcher } = await signUp("ai_viewer_remote");
    const author = await remoteActor("aiauthor", "ai-remote.example");
    await redirectsTo(
      await fetcher(interaction({ uri: "aiauthor@ai-remote.example" })),
      "/@aiauthor@ai-remote.example",
    );
    await redirectsTo(
      await fetcher(interaction({ uri: author.actorUri })),
      "/@aiauthor@ai-remote.example",
    );
    const noteUri = "https://ai-remote.example/users/aiauthor/statuses/1001";
    const note = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: noteUri,
      type: "Note",
      attributedTo: author.actorUri,
      content: "<p>reply to me from your server</p>",
      published: "2026-11-14T00:00:00.000Z",
      to: [PUBLIC],
      cc: [],
    };
    const response = await withRemoteDocuments({ [noteUri]: note }, () =>
      fetcher(interaction({ uri: noteUri })),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^\/@aiauthor@ai-remote\.example\/\d+$/);
    const id = location.split("/").at(-1) ?? "";
    const shown = await SELF.fetch(`${ORIGIN}/api/v1/statuses/${id}`);
    expect(expectContract(ApiStatus, await shown.json()).uri).toBe(noteUri);
  });

  it("shows a not-found page for what it cannot resolve or the viewer may not see", async () => {
    const { fetcher } = await signUp("ai_viewer_missing");
    const hidden = await post("ai-private@example.com", "followers only", "private");
    for (const params of [
      { uri: `${ORIGIN}/@ai_never_existed` },
      { uri: "ai_never_existed@example.com" },
      { uri: hidden.uri },
      {},
    ]) {
      const response = await fetcher(interaction(params));
      expect(response.status, JSON.stringify(params)).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await response.text()).toContain("isn't here");
    }
  });
});

describe("routes that lead to /authorize_interaction", () => {
  it("redirects /authorize_follow and /.well-known/proxy with their query", async () => {
    for (const path of ["/authorize_follow", "/.well-known/proxy"]) {
      const response = await SELF.fetch(`${ORIGIN}${path}?acct=someone%40remote.example`, {
        redirect: "manual",
      });
      expect(response.status, path).toBe(301);
      expect(response.headers.get("location"), path).toBe(
        "/authorize_interaction?acct=someone%40remote.example",
      );
    }
  });

  it("turns a web+mastodon follow intent into an interaction and a share intent into /share", async () => {
    const intent = (uri: string) =>
      SELF.fetch(`${ORIGIN}/intent?${new URLSearchParams({ uri }).toString()}`, {
        redirect: "manual",
      });
    await redirectsTo(
      await intent("web+mastodon://follow?uri=acct:someone@remote.example"),
      "/authorize_interaction?uri=someone%40remote.example",
    );
    await redirectsTo(
      await intent("web+mastodon://share?text=hello%20world"),
      "/share?text=hello+world",
    );
    for (const uri of ["https://follow?uri=a@b", "web+mastodon://other", "not a uri"]) {
      expect((await intent(uri)).status, uri).toBe(404);
    }
  });
});
