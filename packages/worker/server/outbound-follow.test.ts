import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const RelationshipSchema = z.object({
  id: z.string(),
  following: z.boolean(),
  requested: z.boolean(),
  showing_reblogs: z.boolean(),
  notifying: z.boolean(),
  languages: z.array(z.string()).nullable(),
});

const StatusesSchema = z.array(z.object({ id: z.string(), uri: z.string() }));

const follow = async (email: string, remote: Remote, body: Record<string, unknown> = {}) =>
  json(`/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const unfollow = async (email: string, remote: Remote) =>
  json(`/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/unfollow`, {
    method: "POST",
    headers: await authHeaders(email),
  });

const relationship = async (email: string, remote: Remote) => {
  const response = await json(
    `/api/v1/accounts/relationships?id[]=${RemoteAccountId.encode(remote.actorUri)}`,
    { headers: await authHeaders(email) },
  );
  return read(z.array(RelationshipSchema), response.body)[0];
};

/** The activities of `kind` queued for one inbox each, oldest first. */
const queued = async (email: string, kind: string) => {
  const account = await signedInAccount(email);
  const rows = await env.DB.prepare(
    `SELECT a.payload_json, d.inbox_url FROM outbound_activities a
     JOIN outbox_deliveries d ON d.activity_id = a.id AND d.inbox_url IS NOT NULL
     WHERE a.account_id = ? AND a.kind = ? ORDER BY a.rowid`,
  )
    .bind(account.id, kind)
    .all<{ payload_json: string; inbox_url: string }>();
  return rows.results.map((row) => ({
    inbox: row.inbox_url,
    activity: read(
      z.object({ id: z.string(), type: z.string(), actor: z.string(), object: z.unknown() }),
      JSON.parse(row.payload_json),
    ),
  }));
};

const followActivityId = async (email: string): Promise<string> => {
  const follows = await queued(email, "Follow");
  const id = follows.at(-1)?.activity.id;
  if (!id) {
    throw new Error("no Follow was queued");
  }
  return id;
};

const accept = async (remote: Remote, followId: string, slug: string) =>
  remote.send({ id: `${remote.actorUri}/accepts/${slug}`, type: "Accept", object: followId });

const followingCount = async (email: string): Promise<number> =>
  read(
    z.object({ following_count: z.number() }),
    (
      await json("/api/v1/accounts/verify_credentials", {
        headers: await authHeaders(email),
      })
    ).body,
  ).following_count;

const post = async (
  author: Remote,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const noteUri = `https://remote.example/notes/${slug}`;
  expect(
    await author.send({
      id: `${noteUri}/activity`,
      type: "Create",
      object: {
        id: noteUri,
        type: "Note",
        attributedTo: author.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: [PUBLIC],
        cc: [`${author.actorUri}/followers`],
        ...extra,
      },
    }),
  ).toBe(202);
  return noteUri;
};

const homeUris = async (email: string, query = ""): Promise<string[]> =>
  read(
    StatusesSchema,
    (await json(`/api/v1/timelines/home${query}`, { headers: await authHeaders(email) })).body,
  ).map((status) => status.uri);

/** Follow `remote` as `email` and have it accept. */
const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  expect((await follow(email, remote)).status).toBe(200);
  expect(await accept(remote, await followActivityId(email), slug)).toBe(202);
};

describe("following a remote account", () => {
  it("sends a Follow to the actor's inbox and answers requested", async () => {
    const remote = await remoteActor("follow-target");
    const email = "remote-follower@example.com";
    const viewer = await signedInAccount(email);

    const followed = await follow(email, remote);
    expect(followed.status).toBe(200);
    expect(read(RelationshipSchema, followed.body)).toMatchObject({
      id: RemoteAccountId.encode(remote.actorUri),
      following: false,
      requested: true,
    });

    const follows = await queued(email, "Follow");
    expect(follows).toHaveLength(1);
    expect(follows[0]?.inbox).toBe(`${remote.actorUri}/inbox`);
    expect(follows[0]?.activity).toMatchObject({
      type: "Follow",
      actor: `https://example.com/users/${viewer.username}`,
      object: remote.actorUri,
    });
  });

  it("follows again without sending a second Follow, updating the options", async () => {
    const remote = await remoteActor("refollow-target");
    const email = "remote-refollower@example.com";
    expect((await follow(email, remote)).status).toBe(200);

    const again = await follow(email, remote, { reblogs: false, languages: ["en"] });
    expect(again.status).toBe(200);
    expect(read(RelationshipSchema, again.body)).toMatchObject({
      requested: true,
      showing_reblogs: false,
      languages: ["en"],
    });
    expect(await queued(email, "Follow")).toHaveLength(1);
  });

  it("answers 404 for a remote account that is not cached", async () => {
    const unknown = RemoteAccountId.encode("https://remote.example/users/nobody-here");
    const response = await json(`/api/v1/accounts/${unknown}/follow`, {
      method: "POST",
      headers: await authHeaders("remote-follower-404@example.com"),
    });
    expect(response.status).toBe(404);
  });

  it("refuses to follow an actor on a suspended domain", async () => {
    const remote = await remoteActor("suspended-target", "suspended-follow.example");
    const blocked = await json("/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("follow-suspend-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({ domain: "suspended-follow.example", severity: "suspend" }),
    });
    expect(blocked.status).toBe(200);
    const email = "suspended-follower@example.com";

    expect((await follow(email, remote)).status).toBe(403);
    expect(await queued(email, "Follow")).toHaveLength(0);
    expect(await relationship(email, remote)).toMatchObject({ following: false, requested: false });
  });

  it("becomes a follow once the actor signs an Accept", async () => {
    const remote = await remoteActor("accepting-target");
    const email = "accepted-follower@example.com";
    const viewer = await signedInAccount(email);
    const before = await followingCount(email);
    expect((await follow(email, remote)).status).toBe(200);
    expect(await accept(remote, await followActivityId(email), "accepted")).toBe(202);

    expect(await relationship(email, remote)).toMatchObject({ following: true, requested: false });
    expect(await followingCount(email)).toBe(before + 1);
    const following = await json(`/api/v1/accounts/${viewer.id}/following`, {
      headers: await authHeaders(email),
    });
    expect(read(z.array(z.object({ id: z.string() })), following.body).map((a) => a.id)).toEqual([
      RemoteAccountId.encode(remote.actorUri),
    ]);
    const collection = await json(`/users/${viewer.username}/following`);
    expect(collection.body).toMatchObject({ orderedItems: [remote.actorUri] });
  });

  it("accepts an Accept that embeds the Follow", async () => {
    const remote = await remoteActor("embedding-target");
    const email = "embedded-accept-follower@example.com";
    const viewer = await signedInAccount(email);
    expect((await follow(email, remote)).status).toBe(200);

    expect(
      await remote.send({
        id: `${remote.actorUri}/accepts/embedded`,
        type: "Accept",
        object: {
          id: `${remote.actorUri}/follows/rewritten`,
          type: "Follow",
          actor: `https://example.com/users/${viewer.username}`,
          object: remote.actorUri,
        },
      }),
    ).toBe(202);
    expect(await relationship(email, remote)).toMatchObject({ following: true });
  });

  it("ignores an Accept signed by a different actor", async () => {
    const remote = await remoteActor("followed-target");
    const impostor = await remoteActor("impostor");
    const email = "impostor-follower@example.com";
    expect((await follow(email, remote)).status).toBe(200);

    expect(await accept(impostor, await followActivityId(email), "impostor")).toBe(202);
    expect(await relationship(email, remote)).toMatchObject({ following: false, requested: true });
  });

  it("drops the follow when the actor rejects it", async () => {
    const remote = await remoteActor("rejecting-target");
    const email = "rejected-follower@example.com";
    expect((await follow(email, remote)).status).toBe(200);

    expect(
      await remote.send({
        id: `${remote.actorUri}/rejects/1`,
        type: "Reject",
        object: await followActivityId(email),
      }),
    ).toBe(202);
    expect(await relationship(email, remote)).toMatchObject({ following: false, requested: false });
  });

  it("drops the follow when the actor deletes its account", async () => {
    const remote = await remoteActor("deleted-target");
    const email = "deleted-target-follower@example.com";
    const before = await followingCount(email);
    await acceptedFollow(email, remote, "deleted");
    expect(await followingCount(email)).toBe(before + 1);

    expect(
      await remote.send({
        id: `${remote.actorUri}#delete`,
        type: "Delete",
        object: remote.actorUri,
      }),
    ).toBe(202);
    expect(await followingCount(email)).toBe(before);
  });
});

describe("the home timeline of a remote follower", () => {
  it("shows the followed actor's notes to its follower only", async () => {
    const remote = await remoteActor("home-author");
    const follower = "home-follower@example.com";
    const other = "home-other@example.com";
    await signedInAccount(other);
    await acceptedFollow(follower, remote, "home");

    const publicNote = await post(remote, "home-public");
    const followersNote = await post(remote, "home-followers", {
      to: [`${remote.actorUri}/followers`],
      cc: [],
    });

    const home = await homeUris(follower);
    expect(home).toEqual([followersNote, publicNote]);
    expect(await homeUris(other)).toEqual([]);

    const newest = read(
      StatusesSchema,
      (await json("/api/v1/timelines/home", { headers: await authHeaders(follower) })).body,
    )[0];
    expect(newest?.uri).toBe(followersNote);
    expect(await homeUris(follower, `?max_id=${newest?.id ?? ""}`)).toEqual([publicNote]);
    expect(await homeUris(follower, `?min_id=${newest?.id ?? ""}`)).toEqual([]);

    const status = await json(`/api/v1/statuses/${newest?.id ?? ""}`, {
      headers: await authHeaders(follower),
    });
    expect(status.status).toBe(200);
    const hidden = await json(`/api/v1/statuses/${newest?.id ?? ""}`, {
      headers: await authHeaders(other),
    });
    expect(hidden.status).toBe(404);
  });

  it("keeps a requested follow's notes out until the Accept", async () => {
    const remote = await remoteActor("home-pending-author");
    const email = "home-pending-follower@example.com";
    expect((await follow(email, remote)).status).toBe(200);
    await post(remote, "home-pending");

    expect(await homeUris(email)).toEqual([]);
  });

  it("keeps only the follow's languages", async () => {
    const remote = await remoteActor("home-language-author");
    const email = "home-language-follower@example.com";
    expect((await follow(email, remote, { languages: ["en"] })).status).toBe(200);
    expect(await accept(remote, await followActivityId(email), "language")).toBe(202);
    const english = await post(remote, "home-english", { contentMap: { en: "<p>hi</p>" } });
    await post(remote, "home-german", { contentMap: { de: "<p>hallo</p>" } });

    expect(await homeUris(email)).toEqual([english]);
  });

  it("leaves out a followed actor the viewer blocks", async () => {
    const remote = await remoteActor("home-blocked-author");
    const email = "home-blocking-follower@example.com";
    await acceptedFollow(email, remote, "blocked");
    await post(remote, "home-blocked");

    const blocked = await json(
      `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/block`,
      { method: "POST", headers: await authHeaders(email) },
    );
    expect(blocked.status).toBe(200);
    expect(await homeUris(email)).toEqual([]);
  });

  it("sends Undo on unfollow and stops showing the actor's notes", async () => {
    const remote = await remoteActor("home-unfollowed-author");
    const email = "home-unfollower@example.com";
    await acceptedFollow(email, remote, "unfollowed");
    const note = await post(remote, "home-unfollowed");
    expect(await homeUris(email)).toEqual([note]);
    const followId = await followActivityId(email);

    const unfollowed = await unfollow(email, remote);
    expect(unfollowed.status).toBe(200);
    expect(read(RelationshipSchema, unfollowed.body)).toMatchObject({
      following: false,
      requested: false,
    });
    const undos = await queued(email, "Undo");
    expect(undos).toHaveLength(1);
    expect(undos[0]?.inbox).toBe(`${remote.actorUri}/inbox`);
    expect(undos[0]?.activity).toMatchObject({
      type: "Undo",
      object: { id: followId, type: "Follow", object: remote.actorUri },
    });
    expect(await homeUris(email)).toEqual([]);
  });
});
