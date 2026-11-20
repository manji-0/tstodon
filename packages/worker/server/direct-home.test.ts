import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { type Heard, openStream } from "../test/stream-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon's `FanOutOnWriteService` puts a direct note in its local author's
// home (`deliver_to_self!`) and in the home of each local account it mentions
// that follows the author (`deliver_to_mentioned_followers!`), through
// `FeedManager#filter_from_home`; never in a list or a public timeline.

const ORIGIN = "https://example.com";
const HOST = "dm-home.example";

const request = async (email: string, path: string, init: RequestInit = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });

const call = async (email: string, path: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await request(email, path, init);
  expect(response.status, path).toBe(200);
  return response.json();
};

const idsIn = async (email: string, path: string): Promise<string[]> =>
  z
    .array(z.object({ id: z.string() }))
    .parse(await call(email, path))
    .map((entry) => entry.id);

const homeIds = (email: string, query = ""): Promise<string[]> =>
  idsIn(email, `/api/v1/timelines/home${query}`);

const postStatus = async (
  email: string,
  status: string,
  visibility: "public" | "direct",
): Promise<string> =>
  z.object({ id: z.string() }).parse(
    await call(email, "/api/v1/statuses", {
      method: "POST",
      body: JSON.stringify({ status, visibility }),
    }),
  ).id;

const followLocal = async (email: string, targetId: string): Promise<void> => {
  await call(email, `/api/v1/accounts/${targetId}/follow`, { method: "POST", body: "{}" });
};

const createList = async (
  email: string,
  title: string,
  memberId: string,
  exclusive = false,
): Promise<string> => {
  const list = z.object({ id: z.string() }).parse(
    await call(email, "/api/v1/lists", {
      method: "POST",
      body: JSON.stringify({ title, exclusive }),
    }),
  );
  await call(email, `/api/v1/lists/${list.id}/accounts`, {
    method: "POST",
    body: JSON.stringify({ account_ids: [memberId] }),
  });
  return list.id;
};

/** Follow `remote` as `email`, and have it accept. */
const followRemote = async (email: string, remote: Remote): Promise<void> => {
  await call(email, `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`, {
    method: "POST",
    body: "{}",
  });
  const viewer = await signedInAccount(email);
  const [row] = parseRows(
    z.object({ follow_activity_id: z.string() }),
    (
      await env.DB.prepare(
        "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
      )
        .bind(viewer.id, remote.actorUri)
        .all()
    ).results,
  );
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${viewer.id}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const actorUrl = (username: string) => `${ORIGIN}/users/${username}`;

/** A direct note `remote` sends to the local accounts it mentions; its stored id. */
const sendDirect = async (remote: Remote, slug: string, usernames: string[]): Promise<string> => {
  const objectUri = `https://${HOST}/notes/${slug}`;
  expect(
    await remote.send({
      id: `${objectUri}/create`,
      type: "Create",
      object: {
        id: objectUri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${slug}</p>`,
        published: new Date().toISOString(),
        to: usernames.map(actorUrl),
        cc: [],
        tag: usernames.map((username) => ({ type: "Mention", href: actorUrl(username) })),
      },
    }),
  ).toBe(202);
  const [row] = parseRows(
    z.object({ id: z.string(), visibility: z.string() }),
    (
      await env.DB.prepare("SELECT id, visibility FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  );
  expect(row?.visibility).toBe("direct");
  if (!row) {
    throw new Error(`remote note ${objectUri} was not stored`);
  }
  return row.id;
};

const StatusPayload = z.object({ id: z.string() });

/** The id of the status an `update` event carries, or undefined for another event. */
const updatedId = (heard: Heard): string | undefined => {
  if (heard.event !== "update") {
    return undefined;
  }
  const parsed = schemaResult(StatusPayload)(JSON.parse(heard.payload));
  return parsed.isOk() ? parsed.value.id : undefined;
};

/** The `user` stream of `email`, read until it hears `update` for `statusId`. */
const heardUpdate = async (
  stream: Awaited<ReturnType<typeof openStream>>,
  statusId: string,
): Promise<boolean> => {
  // The mention notification may come before or after the home entry.
  for (let read = 0; read < 3; read += 1) {
    if (updatedId(await stream.next()) === statusId) {
      return true;
    }
  }
  return false;
};

describe("a local direct note on the home timeline", () => {
  it("is in its author's home and each mentioned follower's, and no one else's", async () => {
    const author = await signedInAccount("dmh-author@example.com");
    const follower = await signedInAccount("dmh-follower@example.com");
    const stranger = await signedInAccount("dmh-stranger@example.com");
    await signedInAccount("dmh-bystander@example.com");
    await followLocal("dmh-follower@example.com", author.id);
    await followLocal("dmh-bystander@example.com", author.id);
    const list = await createList("dmh-follower@example.com", "dm", author.id);

    const id = await postStatus(
      "dmh-author@example.com",
      `@${follower.username} @${stranger.username} a private hello #dmhometag`,
      "direct",
    );

    expect(await homeIds("dmh-author@example.com")).toContain(id);
    expect(await homeIds("dmh-follower@example.com")).toContain(id);
    expect(await homeIds("dmh-stranger@example.com")).not.toContain(id);
    expect(await homeIds("dmh-bystander@example.com")).not.toContain(id);
    expect(await idsIn("dmh-follower@example.com", `/api/v1/timelines/list/${list}`)).not.toContain(
      id,
    );
    for (const path of [
      "/api/v1/timelines/public",
      "/api/v1/timelines/public?local=true",
      "/api/v1/timelines/tag/dmhometag",
    ]) {
      expect(await idsIn("dmh-follower@example.com", path), path).not.toContain(id);
    }
  });

  it("stays out of the home of a hashtag follower it does not mention", async () => {
    await signedInAccount("dmh-tag-author@example.com");
    const mentioned = await signedInAccount("dmh-tag-mentioned@example.com");
    await call("dmh-tag-follower@example.com", "/api/v1/tags/dmhfollowedtag/follow", {
      method: "POST",
      body: "{}",
    });
    // A public note under the hashtag reaches the hashtag follower's home.
    const open = await postStatus("dmh-tag-author@example.com", "open #dmhfollowedtag", "public");

    const id = await postStatus(
      "dmh-tag-author@example.com",
      `@${mentioned.username} closed #dmhfollowedtag`,
      "direct",
    );

    const home = await homeIds("dmh-tag-follower@example.com");
    expect(home).toContain(open);
    expect(home).not.toContain(id);
  });

  it("stays out of the home of a mentioned account whose follow is pending", async () => {
    const author = await signedInAccount("dmh-pending-author@example.com");
    const requester = await signedInAccount("dmh-pending-requester@example.com");
    const locked = await request(
      "dmh-pending-author@example.com",
      "/api/v1/accounts/update_credentials",
      { method: "PATCH", body: JSON.stringify({ locked: true }) },
    );
    expect(locked.status).toBe(200);
    const relationship = z.object({ following: z.boolean(), requested: z.boolean() }).parse(
      await call("dmh-pending-requester@example.com", `/api/v1/accounts/${author.id}/follow`, {
        method: "POST",
        body: "{}",
      }),
    );
    expect(relationship).toMatchObject({ following: false, requested: true });

    const id = await postStatus(
      "dmh-pending-author@example.com",
      `@${requester.username} not yet`,
      "direct",
    );

    expect(await homeIds("dmh-pending-requester@example.com")).not.toContain(id);
  });

  it("pages with the rest of home, and leaves it when deleted", async () => {
    const author = await signedInAccount("dmh-page-author@example.com");
    const follower = await signedInAccount("dmh-page-follower@example.com");
    await followLocal("dmh-page-follower@example.com", author.id);
    const before = await postStatus("dmh-page-author@example.com", "public before", "public");
    const direct = await postStatus(
      "dmh-page-author@example.com",
      `@${follower.username} between`,
      "direct",
    );
    const after = await postStatus("dmh-page-author@example.com", "public after", "public");

    expect(await homeIds("dmh-page-follower@example.com", `?max_id=${after}&limit=1`)).toEqual([
      direct,
    ]);
    expect(await homeIds("dmh-page-follower@example.com", `?min_id=${before}&limit=1`)).toEqual([
      direct,
    ]);

    const deleted = await request("dmh-page-author@example.com", `/api/v1/statuses/${direct}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    for (const email of ["dmh-page-author@example.com", "dmh-page-follower@example.com"]) {
      expect(await homeIds(email)).not.toContain(direct);
    }
  });

  it("stays out of the home of a follower who mutes or lists the author exclusively", async () => {
    const author = await signedInAccount("dmh-filter-author@example.com");
    const muter = await signedInAccount("dmh-filter-muter@example.com");
    const lister = await signedInAccount("dmh-filter-lister@example.com");
    await followLocal("dmh-filter-muter@example.com", author.id);
    await followLocal("dmh-filter-lister@example.com", author.id);
    await call("dmh-filter-muter@example.com", `/api/v1/accounts/${author.id}/mute`, {
      method: "POST",
      body: "{}",
    });
    await createList("dmh-filter-lister@example.com", "only", author.id, true);

    const id = await postStatus(
      "dmh-filter-author@example.com",
      `@${muter.username} @${lister.username} muted`,
      "direct",
    );

    expect(await homeIds("dmh-filter-muter@example.com")).not.toContain(id);
    expect(await homeIds("dmh-filter-lister@example.com")).not.toContain(id);
  });

  it("reaches the user stream of a mentioned follower, not of another follower", async () => {
    const author = await signedInAccount("dmh-stream-author@example.com");
    // Opened first, so a fan-out reaches it before the mentioned follower.
    const bystander = await openStream({
      email: "dmh-stream-bystander@example.com",
      query: "?stream=user",
    });
    const follower = await openStream({
      email: "dmh-stream-follower@example.com",
      query: "?stream=user",
    });
    await followLocal("dmh-stream-bystander@example.com", author.id);
    await followLocal("dmh-stream-follower@example.com", author.id);
    const username = (await signedInAccount("dmh-stream-follower@example.com")).username;

    const id = await postStatus("dmh-stream-author@example.com", `@${username} psst`, "direct");

    expect(await heardUpdate(follower, id)).toBe(true);
    expect(await bystander.heardNothing()).toBe(true);
    bystander.close();
    follower.close();
  });
});

describe("a remote direct note on the home timeline", () => {
  it("is in the home of each mentioned follower, and in no list", async () => {
    const follower = await signedInAccount("dmh-remote-follower@example.com");
    const stranger = await signedInAccount("dmh-remote-stranger@example.com");
    const author = await remoteActor("dmhremote", HOST);
    await followRemote("dmh-remote-follower@example.com", author);
    await followRemote("dmh-remote-bystander@example.com", author);
    const list = await createList(
      "dmh-remote-follower@example.com",
      "remote dm",
      RemoteAccountId.encode(author.actorUri),
    );

    const id = await sendDirect(author, "dmh-remote", [follower.username, stranger.username]);

    expect(await homeIds("dmh-remote-follower@example.com")).toContain(id);
    expect(await homeIds("dmh-remote-stranger@example.com")).not.toContain(id);
    expect(await homeIds("dmh-remote-bystander@example.com")).not.toContain(id);
    expect(
      await idsIn("dmh-remote-follower@example.com", `/api/v1/timelines/list/${list}`),
    ).not.toContain(id);
  });

  it("stays out of the home of a mentioned account whose follow is pending", async () => {
    const email = "dmh-remote-pending@example.com";
    const requester = await signedInAccount(email);
    const author = await remoteActor("dmhpending", HOST);
    // Never accepted.
    await call(email, `/api/v1/accounts/${RemoteAccountId.encode(author.actorUri)}/follow`, {
      method: "POST",
      body: "{}",
    });

    const id = await sendDirect(author, "dmh-remote-pending", [requester.username]);

    expect(await homeIds(email)).not.toContain(id);
  });

  it("is in a follower's home while its notification policy holds the mention", async () => {
    const email = "dmh-held@example.com";
    const follower = await signedInAccount(email);
    // The author does not follow back, so `for_not_followers` holds its mention.
    const policy = await request(email, "/api/v2/notifications/policy", {
      method: "PATCH",
      body: JSON.stringify({ for_not_followers: "filter" }),
    });
    expect(policy.status).toBe(200);
    const author = await remoteActor("dmhheld", HOST);
    await followRemote(email, author);

    const id = await sendDirect(author, "dmh-held", [follower.username]);

    const requests = z
      .array(z.object({ account: z.object({ id: z.string() }) }))
      .parse(await call(email, "/api/v1/notifications/requests"));
    expect(requests.map((entry) => entry.account.id)).toContain(
      RemoteAccountId.encode(author.actorUri),
    );
    expect(await homeIds(email)).toContain(id);
  });

  it("reaches the user stream of a mentioned follower", async () => {
    const stream = await openStream({
      email: "dmh-remote-stream@example.com",
      query: "?stream=user",
    });
    const username = (await signedInAccount("dmh-remote-stream@example.com")).username;
    const author = await remoteActor("dmhstream", HOST);
    await followRemote("dmh-remote-stream@example.com", author);

    const id = await sendDirect(author, "dmh-remote-stream", [username]);

    expect(await heardUpdate(stream, id)).toBe(true);
    stream.close();
  });

  it("leaves the user stream of a mentioned follower when its author's account is deleted", async () => {
    const email = "dmh-remote-purge@example.com";
    const bystanderEmail = "dmh-remote-purge-bystander@example.com";
    // Opened first, so a fan-out reaches it before the mentioned follower.
    const bystander = await openStream({ email: bystanderEmail, query: "?stream=user" });
    const stream = await openStream({ email, query: "?stream=user" });
    const username = (await signedInAccount(email)).username;
    const author = await remoteActor("dmhpurge", HOST);
    await followRemote(bystanderEmail, author);
    await followRemote(email, author);
    const id = await sendDirect(author, "dmh-remote-purge", [username]);
    expect(await heardUpdate(stream, id)).toBe(true);

    expect(
      await author.send({
        id: `${author.actorUri}#delete`,
        type: "Delete",
        object: author.actorUri,
      }),
    ).toBe(202);

    let heard = await stream.next();
    for (let read = 0; read < 3 && heard.event !== "delete"; read += 1) {
      heard = await stream.next();
    }
    expect(heard).toEqual({ stream: ["user"], event: "delete", payload: id });
    expect(await homeIds(email)).not.toContain(id);
    // The note was never on its home, so it hears no delete of it.
    expect(await bystander.heardNothing()).toBe(true);
    stream.close();
    bystander.close();
  });
});
