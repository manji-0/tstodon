import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const body: unknown = contentType.includes("json") && text.length > 0 ? JSON.parse(text) : text;
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const Ids = z.array(z.object({ id: z.string() }));
const IdRow = z.object({ id: z.string() });

const post = async (email: string, path: string, body: unknown = {}) => {
  const response = await json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status, path).toBe(200);
  return response.body;
};

const posted = async (email: string, body: Record<string, unknown>) =>
  read(IdRow, await post(email, "/api/v1/statuses", body)).id;

const reblogged = async (email: string, statusId: string) =>
  read(IdRow, await post(email, `/api/v1/statuses/${statusId}/reblog`)).id;

const statusOf = async (path: string, email?: string) =>
  (await json(path, email ? { headers: await authHeaders(email) } : undefined)).status;

const idsAt = async (path: string, email?: string): Promise<string[]> => {
  const response = await json(path, email ? { headers: await authHeaders(email) } : undefined);
  expect(response.status, path).toBe(200);
  return read(Ids, response.body).map((entry) => entry.id);
};

const rowId = async (sql: string, bind: string): Promise<string> =>
  read(IdRow, await env.DB.prepare(sql).bind(bind).first()).id;

/** `remote`'s public note, `name`, cached here; its local id. */
const remoteNote = async (
  remote: Remote,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const uri = `${remote.actorUri}/statuses/${name}`;
  expect(
    await remote.send({
      id: `${uri}/activity`,
      type: "Create",
      object: {
        id: uri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${name}</p>`,
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [`${remote.actorUri}/followers`],
        ...extra,
      },
    }),
  ).toBe(202);
  return rowId("SELECT id FROM remote_statuses WHERE object_uri = ?", uri);
};

/** `remote` blocks the local account `username`, as an inbound `Block`. */
const remoteBlocks = async (remote: Remote, username: string) => {
  expect(
    await remote.send({
      id: `${remote.actorUri}#blocks/${username}`,
      type: "Block",
      object: `https://example.com/users/${username}`,
    }),
  ).toBe(202);
};

/** Mastodon's `AccountStatusesFilter#filtered_reblogs_scope`. */
describe("an account's boosts as another viewer sees them", () => {
  it("leave out boosts of authors the viewer blocks, mutes, is blocked by or domain-blocks", async () => {
    const booster = "bba-booster@example.com";
    const viewer = "bba-viewer@example.com";
    const stranger = "bba-stranger@example.com";
    const boosterId = (await signedInAccount(booster)).id;
    const { id: viewerId, username } = await signedInAccount(viewer);
    await signedInAccount(stranger);

    const blockerPost = await posted("bba-blocker@example.com", { status: "by a blocker" });
    const blockedPost = await posted("bba-blocked@example.com", { status: "by a blocked one" });
    const mutedPost = await posted("bba-muted@example.com", { status: "by a muted one" });
    const plainPost = await posted("bba-plain@example.com", { status: "by anyone" });
    const blockingRemote = await remoteActor("bba-remote-blocker");
    const blockedDomain = await remoteActor("bba-remote-domain", "bba-blocked.test");
    const remoteBlockerPost = await remoteNote(blockingRemote, "bba-remote-1");
    const domainPost = await remoteNote(blockedDomain, "bba-remote-2");

    const boosts = [];
    for (const id of [blockerPost, blockedPost, mutedPost, remoteBlockerPost, domainPost]) {
      boosts.push(await reblogged(booster, id));
    }
    const plainBoost = await reblogged(booster, plainPost);

    const blockedId = (await signedInAccount("bba-blocked@example.com")).id;
    const mutedId = (await signedInAccount("bba-muted@example.com")).id;
    await post("bba-blocker@example.com", `/api/v1/accounts/${viewerId}/block`);
    await post(viewer, `/api/v1/accounts/${blockedId}/block`);
    await post(viewer, `/api/v1/accounts/${mutedId}/mute`);
    await remoteBlocks(blockingRemote, username);
    expect(
      (
        await json("/api/v1/domain_blocks", {
          method: "POST",
          headers: { "content-type": "application/json", ...(await authHeaders(viewer)) },
          body: JSON.stringify({ domain: "bba-blocked.test" }),
        })
      ).status,
    ).toBe(200);

    const path = `/api/v1/accounts/${boosterId}/statuses`;
    expect(await idsAt(path, viewer)).toEqual([plainBoost]);
    expect(await idsAt(path, stranger)).toEqual([plainBoost, ...boosts.toReversed()]);
    expect(await idsAt(path)).toEqual([plainBoost, ...boosts.toReversed()]);
    expect(await idsAt(path, booster)).toEqual([plainBoost, ...boosts.toReversed()]);
  });
});

/** Mastodon hides an account that blocks the viewer from the viewer's lists, as a local blocker. */
describe("a remote actor that blocks the viewer", () => {
  it("is left out of its profile, the public timeline and a thread", async () => {
    const viewer = "rbv-viewer@example.com";
    const other = "rbv-other@example.com";
    const { username } = await signedInAccount(viewer);
    await signedInAccount(other);
    const viewerPost = await posted(viewer, { status: "a thread" });
    const remote = await remoteActor("rbv-remote-blocker");
    const noteId = await remoteNote(remote, "rbv-1");
    const replyId = await remoteNote(remote, "rbv-reply", {
      inReplyTo: `https://example.com/users/${username}/statuses/${viewerPost}`,
    });
    const profile = `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/statuses`;
    const publicRemote = "/api/v1/timelines/public?remote=true&limit=40";
    const descendants = async (email: string) =>
      read(
        z.object({ descendants: Ids }),
        (
          await json(`/api/v1/statuses/${viewerPost}/context`, {
            headers: await authHeaders(email),
          })
        ).body,
      ).descendants.map((entry) => entry.id);
    expect(await idsAt(profile, viewer)).toEqual([replyId, noteId]);
    expect(await idsAt(publicRemote, viewer)).toEqual(expect.arrayContaining([replyId, noteId]));
    expect(await descendants(viewer)).toEqual([replyId]);

    await remoteBlocks(remote, username);

    expect(await idsAt(profile, viewer)).toEqual([]);
    expect(await idsAt(`${profile}?pinned=true`, viewer)).toEqual([]);
    expect(await idsAt(publicRemote, viewer)).not.toEqual(expect.arrayContaining([noteId]));
    expect(await idsAt(publicRemote, viewer)).not.toEqual(expect.arrayContaining([replyId]));
    expect(await descendants(viewer)).toEqual([]);
    expect(await idsAt(profile, other)).toEqual([replyId, noteId]);
    expect(await idsAt(publicRemote, other)).toEqual(expect.arrayContaining([replyId, noteId]));
    expect(await descendants(other)).toEqual([replyId]);
  });

  it("hides its public boost from the viewer by id", async () => {
    const viewer = "rbb-viewer@example.com";
    const { username } = await signedInAccount(viewer);
    const author = await remoteActor("rbb-author");
    const booster = await remoteActor("rbb-booster");
    const noteUri = `${author.actorUri}/statuses/rbb-1`;
    await remoteNote(author, "rbb-1");
    const announceId = `${booster.actorUri}/statuses/rbb-boost/activity`;
    expect(
      await booster.send({
        id: announceId,
        type: "Announce",
        object: noteUri,
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [`${booster.actorUri}/followers`],
      }),
    ).toBe(202);
    const boostId = await rowId("SELECT id FROM remote_boosts WHERE activity_id = ?", announceId);
    expect(await statusOf(`/api/v1/statuses/${boostId}`, viewer)).toBe(200);

    await remoteBlocks(booster, username);

    expect(await statusOf(`/api/v1/statuses/${boostId}`, viewer)).toBe(404);
    expect(await statusOf(`/api/v1/statuses/${boostId}`)).toBe(200);
  });
});

/** Mastodon's `PublicFeed` is `without_reblogs`, so a boost never carries its target there. */
describe("boosts on the public timelines", () => {
  it("are left out, local and remote, whoever asks", async () => {
    const booster = "pbt-booster@example.com";
    const viewer = "pbt-viewer@example.com";
    const { id: viewerId } = await signedInAccount(viewer);
    const blockerPost = await posted("pbt-blocker@example.com", { status: "by a blocker" });
    const plainPost = await posted("pbt-plain@example.com", { status: "by anyone" });
    await post("pbt-blocker@example.com", `/api/v1/accounts/${viewerId}/block`);
    const localBoosts = [
      await reblogged(booster, blockerPost),
      await reblogged(booster, plainPost),
    ];

    const author = await remoteActor("pbt-remote-author");
    const remoteBooster = await remoteActor("pbt-remote-booster");
    const remotePost = await remoteNote(author, "pbt-1");
    const announceId = `${remoteBooster.actorUri}/statuses/pbt-boost/activity`;
    expect(
      await remoteBooster.send({
        id: announceId,
        type: "Announce",
        object: `${author.actorUri}/statuses/pbt-1`,
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [`${remoteBooster.actorUri}/followers`],
      }),
    ).toBe(202);
    const remoteBoost = await rowId(
      "SELECT id FROM remote_boosts WHERE activity_id = ?",
      announceId,
    );

    for (const email of [viewer, undefined]) {
      const local = await idsAt("/api/v1/timelines/public?local=true&limit=40", email);
      const remote = await idsAt("/api/v1/timelines/public?remote=true&limit=40", email);
      const all = await idsAt("/api/v1/timelines/public?limit=40", email);
      for (const boost of [...localBoosts, remoteBoost]) {
        expect([...local, ...remote, ...all]).not.toContain(boost);
      }
      expect(local).toContain(plainPost);
      expect(remote).toContain(remotePost);
    }
  });
});
