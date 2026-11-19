import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount, ApiNotification, ApiStatus } from "@tstodon/api";
import { ApActorDocument, ApOutboxPage, ApStatusDocument } from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { openStream } from "../test/stream-fixture";

/**
 * Where a local account's and a local status's `url` lead, as Mastodon's
 * `ActivityPub::TagManager#url_for`: the web app's pages `/@name` and
 * `/@name/id`, while `uri` stays the ActivityPub id under `/users/name`.
 */

const ORIGIN = "https://example.com";
const AP_ACCEPT = "application/activity+json";

const api = async (email: string, method: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(new URL(path, ORIGIN), {
    method,
    headers: {
      ...(await authHeaders(email)),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response.json();
};

const activityJson = async (path: string): Promise<unknown> => {
  const response = await SELF.fetch(new URL(path, ORIGIN), { headers: { Accept: AP_ACCEPT } });
  expect(response.status, path).toBe(200);
  return response.json();
};

describe("a local status's url", () => {
  it("is its page in the web app, in REST, ActivityPub, notifications and streaming", async () => {
    const author = await signedInAccount("local-urls-author@example.com");
    const reader = await signedInAccount("local-urls-reader@example.com");
    const stream = await openStream({
      email: "local-urls-author@example.com",
      query: "?stream=user",
    });

    const posted = expectContract(
      ApiStatus,
      await api("local-urls-author@example.com", "POST", "/api/v1/statuses", {
        status: `@${reader.username} hello`,
      }),
    );
    const page = `${ORIGIN}/@${author.username}/${posted.id}`;
    const uri = `${ORIGIN}/users/${author.username}/statuses/${posted.id}`;
    expect({ url: posted.url, uri: posted.uri }).toEqual({ url: page, uri });

    const shown = expectContract(
      ApiStatus,
      await api("local-urls-reader@example.com", "GET", `/api/v1/statuses/${posted.id}`),
    );
    expect(shown.url).toBe(page);

    const notifications = expectContract(
      z.array(ApiNotification),
      await api("local-urls-reader@example.com", "GET", "/api/v1/notifications?types[]=mention"),
    );
    const mentioned = notifications.flatMap((n) => ("status" in n && n.status ? [n.status] : []));
    expect(mentioned.find((status) => status.id === posted.id)?.url).toBe(page);

    const heard = await stream.nextDecoded();
    expect(heard.event).toBe("update");
    expect(heard.event === "update" && heard.payload.url).toBe(page);
    stream.close();

    const note = expectContract(ApStatusDocument, await activityJson(new URL(uri).pathname));
    expect({ id: note.id, url: note.url }).toEqual({ id: uri, url: page });

    const outbox = expectContract(
      ApOutboxPage,
      await activityJson(`/users/${author.username}/outbox?page=true`),
    );
    const created = outbox.orderedItems.find(
      (item) => item.type === "Create" && item.object.id === uri,
    );
    expect(created?.object).toMatchObject({ url: page });
  });

  it("is the reblogged status's page in a boost", async () => {
    const author = await signedInAccount("local-urls-boosted@example.com");
    const posted = expectContract(
      ApiStatus,
      await api("local-urls-boosted@example.com", "POST", "/api/v1/statuses", {
        status: "boost me",
      }),
    );
    const boost = expectContract(
      ApiStatus,
      await api("local-urls-reader@example.com", "POST", `/api/v1/statuses/${posted.id}/reblog`),
    );
    expect(boost.reblog?.url).toBe(`${ORIGIN}/@${author.username}/${posted.id}`);
  });
});

describe("a local account's url", () => {
  it("is its profile page in the web app, in REST and on its actor", async () => {
    const account = await signedInAccount("local-urls-profile@example.com");
    const profile = `${ORIGIN}/@${account.username}`;
    const actor = `${ORIGIN}/users/${account.username}`;

    const rest = expectContract(
      ApiAccount,
      await api("local-urls-profile@example.com", "GET", `/api/v1/accounts/${account.id}`),
    );
    expect({ url: rest.url, uri: rest.uri }).toEqual({ url: profile, uri: actor });

    const document = expectContract(
      ApActorDocument,
      await activityJson(`/users/${account.username}`),
    );
    expect({ id: document.id, url: document.url }).toEqual({ id: actor, url: profile });
  });
});
