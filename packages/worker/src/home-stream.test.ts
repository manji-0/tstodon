import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { OutboxJob } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { type Heard, openStream as openSocket } from "../test/stream-fixture";
import { fanOutHomePage, HOME_FAN_OUT_PAGE_SIZE } from "./home-fan-out";
import { RemoteAccountId } from "./remote-account-id";
import { parseInstanceIdentity } from "./runtime-config";

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const StatusPayloadSchema = z.object({
  id: z.string(),
  uri: z.string(),
  content: z.string(),
  account: z.object({ id: z.string() }),
  reblog: z.object({ id: z.string(), uri: z.string() }).nullable(),
});

/** The status an `update` or `status.update` carries. */
const statusOf = (heard: Pick<Heard, "payload">) => {
  const parsed = schemaResult(StatusPayloadSchema)(JSON.parse(heard.payload));
  if (parsed.isErr()) {
    throw new Error("status payload rejected");
  }
  return parsed.value;
};

/** The `user` stream of the account signed in as `email`. */
const openStream = async (email: string) => {
  const stream = await openSocket({ email, query: "?stream=user" });
  if (!stream.account) {
    throw new Error("missing account");
  }
  return { ...stream, account: stream.account };
};

const json = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(await authHeaders(email)),
    },
  });
  return { status: response.status, body: await response.json() };
};

const post = async (email: string, status: string): Promise<string> => {
  const posted = await json(email, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  expect(posted.status).toBe(200);
  return statusOf({ payload: JSON.stringify(posted.body) }).id;
};

const follow = async (email: string, targetEmail: string, options: object = {}) => {
  const target = await signedInAccount(targetEmail);
  const followed = await json(email, `/api/v1/accounts/${target.id}/follow`, {
    method: "POST",
    body: JSON.stringify(options),
  });
  expect(followed.status).toBe(200);
};

describe("home streams of local followers", () => {
  it("hear a followed account's new post, unless they mute its author", async () => {
    const author = "hs-post-author@example.com";
    // Created first, so a fan-out reaches the muter before the follower.
    const muter = await openStream("hs-post-muter@example.com");
    const follower = await openStream("hs-post-follower@example.com");
    const stranger = await openStream("hs-post-stranger@example.com");
    await follow("hs-post-muter@example.com", author);
    await follow("hs-post-follower@example.com", author);
    const authorAccount = await signedInAccount(author);
    expect(
      (
        await json("hs-post-muter@example.com", `/api/v1/accounts/${authorAccount.id}/mute`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(200);

    const id = await post(author, "fan out to followers");

    const heard = await follower.next();
    expect(heard.event).toBe("update");
    expect(statusOf(heard)).toMatchObject({ id, account: { id: authorAccount.id } });
    expect(await muter.heardNothing()).toBe(true);
    expect(await stranger.heardNothing()).toBe(true);
    for (const stream of [muter, follower, stranger]) {
      stream.close();
    }
  });

  it("hear a followed account's boost, edit, and delete", async () => {
    const author = "hs-life-author@example.com";
    const booster = "hs-life-booster@example.com";
    const follower = await openStream("hs-life-follower@example.com");
    await follow("hs-life-follower@example.com", booster);
    const original = await post(author, "boost me");

    const boosted = await json(booster, `/api/v1/statuses/${original}/reblog`, {
      method: "POST",
      body: "{}",
    });
    expect(boosted.status).toBe(200);
    const boost = statusOf(await follower.next());
    expect(boost.reblog).toMatchObject({ id: original });

    const own = await post(booster, "before the edit");
    expect(statusOf(await follower.next()).id).toBe(own);
    const edited = await json(booster, `/api/v1/statuses/${own}`, {
      method: "PUT",
      body: JSON.stringify({ status: "after the edit" }),
    });
    expect(edited.status).toBe(200);
    const update = await follower.next();
    expect(update.event).toBe("status.update");
    expect(statusOf(update)).toMatchObject({ id: own, content: expect.stringContaining("after") });

    const deleted = await json(booster, `/api/v1/statuses/${own}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await follower.next()).toEqual({ stream: ["user"], event: "delete", payload: own });

    const unboosted = await json(booster, `/api/v1/statuses/${original}/unreblog`, {
      method: "POST",
      body: "{}",
    });
    expect(unboosted.status).toBe(200);
    expect(await follower.next()).toEqual({ stream: ["user"], event: "delete", payload: boost.id });
    follower.close();
  });

  it("are told one page of followers at a time", async () => {
    const author = "hs-paged-author@example.com";
    const opened = [
      await openStream("hs-paged-one@example.com"),
      await openStream("hs-paged-two@example.com"),
    ];
    await follow("hs-paged-one@example.com", author);
    await follow("hs-paged-two@example.com", author);
    const id = await post(author, "paged");
    // The queued fan-out tells both; drain it before driving pages by hand.
    for (const stream of opened) {
      expect(statusOf(await stream.next()).id).toBe(id);
    }
    const [first, second] = opened.toSorted((left, right) =>
      left.account.id.localeCompare(right.account.id),
    );
    const identity = parseInstanceIdentity(env);
    const job = OutboxJob.parse({
      kind: "FanOutHome",
      event: "update",
      entryId: id,
      author: { kind: "LocalAccount", accountId: (await signedInAccount(author)).id },
      afterAccountId: "",
    });
    if (!first || !second || identity.isErr() || job.isErr() || job.value.kind !== "FanOutHome") {
      throw new Error("fan-out fixture rejected");
    }
    expect(HOME_FAN_OUT_PAGE_SIZE).toBeGreaterThan(2);
    const fanOut = job.value;
    const page = (afterAccountId: string) =>
      fanOutHomePage(env, identity.value, { ...fanOut, afterAccountId }, 1);

    const firstPage = await page("");
    expect(firstPage.isOk() && firstPage.value).toBe(first.account.id);
    expect(statusOf(await first.next()).id).toBe(id);
    expect(await second.heardNothing()).toBe(true);

    // A full page always hands on a cursor; the page after the last follower is empty.
    const secondPage = await page(first.account.id);
    expect(secondPage.isOk() && secondPage.value).toBe(second.account.id);
    expect(statusOf(await second.next()).id).toBe(id);
    const lastPage = await page(second.account.id);
    expect(lastPage.isOk() && lastPage.value).toBe(undefined);
    for (const stream of opened) {
      stream.close();
    }
  });
});

/** Follow `remote` as `email`, and have it accept. */
const followRemote = async (email: string, remote: Remote, options: object = {}) => {
  const followed = await json(
    email,
    `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
    {
      method: "POST",
      body: JSON.stringify(options),
    },
  );
  expect(followed.status).toBe(200);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${viewer.id}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const remoteNote = (author: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: `${new URL(author.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content: `<p>${slug}</p>`,
  published: "2026-10-20T00:00:00.000Z",
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
  ...extra,
});

/** Deliver a public note by `author`; resolves to its URI. */
const createRemote = async (author: Remote, slug: string): Promise<string> => {
  const object = remoteNote(author, slug);
  expect(await author.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);
  return object.id;
};

describe("home streams of followers of a remote actor", () => {
  it("hear its new note and its boost, the boost only when the follow shows boosts", async () => {
    const actor = await remoteActor("hs-remote-actor");
    const other = await remoteActor("hs-remote-other", "other.example");
    // Created first, so a fan-out reaches it before the follower.
    const noBoosts = await openStream("hs-remote-noboosts@example.com");
    const follower = await openStream("hs-remote-follower@example.com");
    await followRemote("hs-remote-noboosts@example.com", actor, { reblogs: false });
    await followRemote("hs-remote-follower@example.com", actor);

    const noteUri = await createRemote(actor, "hs-remote-note");
    for (const stream of [noBoosts, follower]) {
      const heard = await stream.next();
      expect(heard.event).toBe("update");
      expect(statusOf(heard)).toMatchObject({ uri: noteUri, reblog: null });
    }

    const otherUri = await createRemote(other, "hs-remote-boosted");
    const announceId = `${actor.actorUri}/statuses/hs-remote-boost/activity`;
    expect(
      await actor.send({
        id: announceId,
        type: "Announce",
        object: otherUri,
        published: "2026-10-21T00:00:00.000Z",
        to: [PUBLIC],
        cc: [`${actor.actorUri}/followers`],
      }),
    ).toBe(202);
    const boost = statusOf(await follower.next());
    expect(boost).toMatchObject({ uri: announceId, reblog: { uri: otherUri } });
    expect(await noBoosts.heardNothing()).toBe(true);

    expect(
      await actor.send({
        id: `${announceId}/undo`,
        type: "Undo",
        object: announceId,
      }),
    ).toBe(202);
    expect(await follower.next()).toEqual({ stream: ["user"], event: "delete", payload: boost.id });
    for (const stream of [noBoosts, follower]) {
      stream.close();
    }
  });

  it("hear its edit and its delete", async () => {
    const actor = await remoteActor("hs-remote-editor");
    const follower = await openStream("hs-remote-edit-follower@example.com");
    await followRemote("hs-remote-edit-follower@example.com", actor);
    const noteUri = await createRemote(actor, "hs-remote-edit");
    const created = statusOf(await follower.next());

    expect(
      await actor.send({
        id: `${noteUri}/update`,
        type: "Update",
        object: remoteNote(actor, "hs-remote-edit", {
          content: "<p>edited</p>",
          updated: "2026-10-21T12:00:00.000Z",
        }),
      }),
    ).toBe(202);
    const edited = await follower.next();
    expect(edited.event).toBe("status.update");
    expect(statusOf(edited)).toMatchObject({ id: created.id, content: "<p>edited</p>" });

    expect(await actor.send({ id: `${noteUri}/delete`, type: "Delete", object: noteUri })).toBe(
      202,
    );
    expect(await follower.next()).toEqual({
      stream: ["user"],
      event: "delete",
      payload: created.id,
    });
    follower.close();
  });
});
