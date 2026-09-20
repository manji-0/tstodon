import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateAccountKeys } from "./keys";
import {
  signInboxRequest,
  verifyInboxRequest,
} from "./http-signature";

const auth = (email: string): HeadersInit => ({
  Authorization: `Bearer dev-secret:${email}`,
});

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

describe("worker http", () => {
  it("serves healthz", async () => {
    const response = await SELF.fetch("https://example.com/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "Ok",
      service: "tstodon",
    });
  });

  it("serves Mastodon instance metadata", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/instance");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: "MastodonInstance",
      uri: "example.com",
      title: "tstodon",
    });
  });

  it("registers a local app", async () => {
    const { status, body } = await json("/api/v1/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "tstodon-test" }),
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "tstodon-test", client_id: "tstodon-local" });
  });

  it("provisions credentials, posts, and reads timelines", async () => {
    const created = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({ status: "hello from alice #intro" }),
    });
    expect(created.status).toBe(200);
    const status = created.body as { id: string; content: string; account: { id: string; username: string } };
    expect(status.content).toContain("hello from alice");
    expect(status.account.username).toBe("alice");

    const me = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ username: "alice", acct: "alice" });

    const publicTl = await json("/api/v1/timelines/public");
    expect(publicTl.status).toBe(200);
    expect(publicTl.body as unknown[]).not.toHaveLength(0);

    const home = await json("/api/v1/timelines/home", {
      headers: auth("alice@example.com"),
    });
    expect(home.status).toBe(200);
    expect(home.body as unknown[]).not.toHaveLength(0);

    const webfinger = await json(
      "/.well-known/webfinger?resource=acct:alice@example.com",
    );
    expect(webfinger.status).toBe(200);
    expect(webfinger.body).toMatchObject({
      subject: "acct:alice@example.com",
    });

    const actor = await json("/users/alice");
    expect(actor.status).toBe(200);
    expect(actor.body).toMatchObject({
      type: "Person",
      preferredUsername: "alice",
    });

    const note = await json(`/users/alice/statuses/${status.id}`);
    expect(note.status).toBe(200);
    expect(note.body).toMatchObject({ type: "Note" });
  });

  it("follows, favourites, notifies, and searches across local accounts", async () => {
    await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    const bobStatus = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("bob@example.com") },
      body: JSON.stringify({ status: "bob says hi @alice" }),
    });
    expect(bobStatus.status).toBe(200);
    const posted = bobStatus.body as { id: string; account: { id: string } };

    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    expect((alice.body as { username: string }).username).toBe("alice");

    const follow = await json(`/api/v1/accounts/${posted.account.id}/follow`, {
      method: "POST",
      headers: auth("alice@example.com"),
    });
    expect(follow.status).toBe(200);
    expect(follow.body).toMatchObject({ following: true });

    const home = await json("/api/v1/timelines/home", {
      headers: auth("alice@example.com"),
    });
    expect((home.body as { id: string }[]).some((item) => item.id === posted.id)).toBe(true);

    const fav = await json(`/api/v1/statuses/${posted.id}/favourite`, {
      method: "POST",
      headers: auth("alice@example.com"),
    });
    expect(fav.status).toBe(200);
    expect(fav.body).toMatchObject({ favourited: true });

    const bobNotes = await json("/api/v1/notifications", {
      headers: auth("bob@example.com"),
    });
    expect(bobNotes.status).toBe(200);
    const bobTypes = (bobNotes.body as { type: string }[]).map((item) => item.type);
    expect(bobTypes).toEqual(expect.arrayContaining(["follow", "favourite"]));

    const aliceNotes = await json("/api/v1/notifications", {
      headers: auth("alice@example.com"),
    });
    expect(aliceNotes.status).toBe(200);
    const aliceTypes = (aliceNotes.body as { type: string }[]).map((item) => item.type);
    expect(aliceTypes).toEqual(expect.arrayContaining(["mention"]));

    const search = await json(`/api/v2/search?q=bob&type=accounts`, {
      headers: auth("alice@example.com"),
    });
    expect(search.status).toBe(200);
    expect((search.body as { accounts: { username: string }[] }).accounts[0]?.username).toBe("bob");

    const relationships = await json(
      `/api/v1/accounts/relationships?id[]=${posted.account.id}`,
      { headers: auth("alice@example.com") },
    );
    expect(relationships.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: posted.account.id, following: true })]),
    );
  });

  it("uploads media, creates polls, filters, and reports", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    const mediaResponse = await SELF.fetch("https://example.com/api/v1/media", {
      method: "POST",
      headers: auth("alice@example.com"),
      body: form,
    });
    expect(mediaResponse.status).toBe(200);
    const media = (await mediaResponse.json()) as { id: string };
    expect(media.id).toBeTruthy();

    const poll = await json("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({
        status: "lunch?",
        poll: { options: ["ramen", "curry"], expires_in: 3600, multiple: false },
      }),
    });
    expect(poll.status).toBe(200);
    const pollStatus = poll.body as { id: string; poll: { id: string } };
    expect(pollStatus.poll.id).toBeTruthy();

    const vote = await json(`/api/v1/polls/${pollStatus.poll.id}/votes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("bob@example.com") },
      body: JSON.stringify({ choices: [0] }),
    });
    expect(vote.status).toBe(200);

    const filter = await json("/api/v1/filters", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({ phrase: "spam", context: ["home"] }),
    });
    expect(filter.status).toBe(200);
    expect(filter.body).toMatchObject({ phrase: "spam" });

    const bob = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("bob@example.com"),
    });
    const report = await json("/api/v1/reports", {
      method: "POST",
      headers: { "content-type": "application/json", ...auth("alice@example.com") },
      body: JSON.stringify({
        account_id: (bob.body as { id: string }).id,
        comment: "test",
      }),
    });
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ action_taken: false });
  });

  it("accepts a local ActivityPub Follow into the inbox", async () => {
    const alice = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("alice@example.com"),
    });
    const carol = await json("/api/v1/accounts/verify_credentials", {
      headers: auth("carol@example.com"),
    });
    expect(alice.status).toBe(200);
    expect(carol.status).toBe(200);
    const inbox = await json("/inbox", {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: JSON.stringify({
        "@context": "https://www.w3.org/ns/activitystreams",
        id: "https://example.com/activities/follow-carol-alice",
        type: "Follow",
        actor: "https://example.com/users/carol",
        object: "https://example.com/users/alice",
      }),
    });
    expect(inbox.status).toBe(202);
    const relationships = await json(
      `/api/v1/accounts/relationships?id=${(alice.body as { id: string }).id}`,
      { headers: auth("carol@example.com") },
    );
    expect(relationships.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ following: true })]),
    );
  });
});

describe("http signatures", () => {
  it("signs and verifies a draft-cavage inbox request", async () => {
    const keys = await generateAccountKeys();
    const body = JSON.stringify({ type: "Follow", actor: "https://example.com/users/alice" });
    const url = new URL("https://remote.example/inbox");
    const headers = await signInboxRequest(
      url,
      keys.privateKeyJwk,
      "https://example.com/users/alice#main-key",
      body,
    );
    const request = new Request(url, { method: "POST", headers, body });
    await expect(verifyInboxRequest(request, keys.publicKeyPem, body)).resolves.toBe(true);
  });
});
