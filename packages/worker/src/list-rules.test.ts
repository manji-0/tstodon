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
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const send = async (email: string, path: string, method: string, body?: unknown) =>
  json(path, {
    method,
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = async (email: string, path: string) =>
  json(path, { headers: await authHeaders(email) });

const remoteId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const followLocal = async (email: string, targetEmail: string): Promise<string> => {
  const target = await signedInAccount(targetEmail);
  expect((await send(email, `/api/v1/accounts/${target.id}/follow`, "POST", {})).status).toBe(200);
  return target.id;
};

const followRemote = async (email: string, remote: Remote, slug: string) => {
  expect(
    (await send(email, `/api/v1/accounts/${remoteId(remote)}/follow`, "POST", {})).status,
  ).toBe(200);
  const viewer = await signedInAccount(email);
  const row = await env.DB.prepare(
    "SELECT follow_activity_id FROM outbound_follows WHERE account_id = ? AND actor_uri = ?",
  )
    .bind(viewer.id, remote.actorUri)
    .first<{ follow_activity_id: string }>();
  expect(
    await remote.send({
      id: `${remote.actorUri}/accepts/${slug}`,
      type: "Accept",
      object: row?.follow_activity_id,
    }),
  ).toBe(202);
};

const createList = async (
  email: string,
  options: Readonly<{ exclusive?: boolean; repliesPolicy?: string }> = {},
): Promise<string> =>
  read(
    z.object({ id: z.string() }),
    (
      await send(email, "/api/v1/lists", "POST", {
        title: "Rules",
        exclusive: options.exclusive ?? false,
        replies_policy: options.repliesPolicy ?? "list",
      })
    ).body,
  ).id;

const addMembers = async (email: string, listId: string, ids: string[]) =>
  expect(
    (await send(email, `/api/v1/lists/${listId}/accounts`, "POST", { account_ids: ids })).status,
  ).toBe(200);

const setList = async (email: string, listId: string, body: object) =>
  expect((await send(email, `/api/v1/lists/${listId}`, "PUT", body)).status).toBe(200);

const StatusSchema = z.object({
  id: z.string(),
  uri: z.string(),
  content: z.string(),
  reblog: z.object({ content: z.string() }).nullable(),
});

/** A local post; resolves to its id and URI. */
const post = async (
  email: string,
  text: string,
  inReplyTo?: Readonly<{ id: string }>,
): Promise<Readonly<{ id: string; uri: string }>> => {
  const posted = await send(email, "/api/v1/statuses", "POST", {
    status: text,
    ...(inReplyTo ? { in_reply_to_id: inReplyTo.id } : {}),
  });
  expect(posted.status).toBe(200);
  return read(StatusSchema, posted.body);
};

const reblog = async (email: string, id: string) =>
  expect((await send(email, `/api/v1/statuses/${id}/reblog`, "POST", {})).status).toBe(200);

/** A note by `author`, delivered to (and cached by) this instance; resolves to its URI. */
const note = async (
  author: Remote,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const noteUri = `${new URL(author.actorUri).origin}/notes/${slug}`;
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

const announce = async (booster: Remote, objectUri: string, slug: string) =>
  expect(
    await booster.send({
      id: `${booster.actorUri}/statuses/${slug}/activity`,
      type: "Announce",
      object: objectUri,
      published: "2026-10-21T00:00:00.000Z",
      to: [PUBLIC],
      cc: [`${booster.actorUri}/followers`],
    }),
  ).toBe(202);

type Entry = z.infer<typeof StatusSchema>;

/** What a reader sees of an entry: its text, a boost as `boost:` and the boosted text. */
const label = (entry: Entry): string =>
  `${entry.reblog ? "boost:" : ""}${(entry.reblog?.content ?? entry.content).replace(/<[^>]+>/g, "")}`;

const labels = async (email: string, path: string): Promise<string[]> =>
  read(z.array(StatusSchema), (await get(email, path)).body).map(label);

/** Every page of `path` at `limit` 1, walking `max_id` back through the timeline. */
const walk = async (email: string, path: string): Promise<string[]> => {
  const seen: string[] = [];
  let maxId: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const [entry] = read(
      z.array(StatusSchema),
      (await get(email, `${path}?limit=1${maxId ? `&max_id=${maxId}` : ""}`)).body,
    );
    if (!entry) {
      break;
    }
    seen.push(label(entry));
    maxId = entry.id;
  }
  return seen;
};

describe("exclusive lists", () => {
  it("keep their local members' posts and boosts off home, paged by id", async () => {
    const owner = "excl-owner@example.com";
    const member = "excl-member@example.com";
    const other = "excl-other@example.com";
    const memberId = await followLocal(owner, member);
    await followLocal(owner, other);
    const listId = await createList(owner, { exclusive: true });
    await addMembers(owner, listId, [memberId]);

    await post(member, "member post");
    const otherPost = await post(other, "other post");
    await reblog(member, otherPost.id);
    await post(other, "other later");

    const home = ["other later", "other post"];
    expect(await labels(owner, "/api/v1/timelines/home")).toEqual(home);
    expect(await walk(owner, "/api/v1/timelines/home")).toEqual(home);
    const { body } = await get(owner, "/api/v1/timelines/home?limit=1");
    const newest = read(z.array(StatusSchema), body)[0]?.id ?? "";
    expect(await labels(owner, `/api/v1/timelines/home?limit=1&max_id=${newest}`)).toEqual([
      "other post",
    ]);
    expect(await labels(owner, `/api/v1/timelines/list/${listId}`)).toEqual([
      "boost:other post",
      "member post",
    ]);

    await setList(owner, listId, { exclusive: false });
    expect(await walk(owner, "/api/v1/timelines/home")).toEqual([
      "other later",
      "boost:other post",
      "other post",
      "member post",
    ]);
  });

  it("keep their remote members' notes and boosts off home, paged by id", async () => {
    const owner = "excl-remote-owner@example.com";
    const remoteMember = await remoteActor("excl-remote-member", "excl-member.example");
    const remoteOther = await remoteActor("excl-remote-other", "excl-other.example");
    await followRemote(owner, remoteMember, "excl-remote-member");
    await followRemote(owner, remoteOther, "excl-remote-other");
    const listId = await createList(owner, { exclusive: true });
    await addMembers(owner, listId, [remoteId(remoteMember)]);

    await note(remoteMember, "remote-member-note");
    const otherNote = await note(remoteOther, "remote-other-note");
    await announce(remoteMember, otherNote, "remote-member-boost");

    expect(await labels(owner, "/api/v1/timelines/home")).toEqual(["remote-other-note"]);
    expect(await walk(owner, "/api/v1/timelines/home")).toEqual(["remote-other-note"]);
    expect(await labels(owner, `/api/v1/timelines/list/${listId}`)).toEqual([
      "boost:remote-other-note",
      "remote-member-note",
    ]);

    await setList(owner, listId, { exclusive: false });
    expect(await walk(owner, "/api/v1/timelines/home")).toEqual([
      "boost:remote-other-note",
      "remote-other-note",
      "remote-member-note",
    ]);
  });
});

/** The local id of a remote note this instance cached. */
const cachedId = async (noteUri: string): Promise<string> =>
  read(
    z.object({ id: z.string() }),
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(noteUri)
      .first(),
  ).id;

/** The boosts among what `email` sees at `path`. */
const boosts = async (email: string, path: string): Promise<string[]> =>
  (await labels(email, path)).filter((entry) => entry.startsWith("boost:"));

describe("local members' boosts", () => {
  it("show on the list, paged by id, unless the owner's follow hides the booster's reblogs", async () => {
    const owner = "boost-list-owner@example.com";
    const member = "boost-list-member@example.com";
    const quiet = "boost-list-quiet@example.com";
    const author = "boost-list-author@example.com";
    const remote = await remoteActor("boost-list-remote", "boost-list.example");
    const memberId = await followLocal(owner, member);
    const quietId = (await signedInAccount(quiet)).id;
    expect(
      (await send(owner, `/api/v1/accounts/${quietId}/follow`, "POST", { reblogs: false })).status,
    ).toBe(200);
    const listId = await createList(owner);
    await addMembers(owner, listId, [memberId, quietId]);

    const authored = await post(author, "author post");
    const remoteNote = await note(remote, "boost-list-note");
    await post(member, "member post");
    await reblog(member, authored.id);
    await reblog(quiet, authored.id);
    await reblog(member, await cachedId(remoteNote));
    await post(quiet, "quiet post");

    const path = `/api/v1/timelines/list/${listId}`;
    const newestFirst = ["quiet post", "boost:boost-list-note", "boost:author post", "member post"];
    expect(await labels(owner, path)).toEqual(newestFirst);
    expect(await walk(owner, path)).toEqual(newestFirst);
    const ids = read(z.array(StatusSchema), (await get(owner, path)).body).map((entry) => entry.id);
    expect(await labels(owner, `${path}?min_id=${ids[3]}&limit=2`)).toEqual([
      "boost:author post",
      "boost:boost-list-note",
    ]);
    expect(await labels(owner, `${path}?since_id=${ids[2]}`)).toEqual([
      "quiet post",
      "boost:boost-list-note",
    ]);
  });

  it("stay off home and the list when the owner blocks or mutes the local boosted author", async () => {
    const owner = "boost-hidden-owner@example.com";
    const member = "boost-hidden-member@example.com";
    const blocked = "boost-hidden-blocked@example.com";
    const muted = "boost-hidden-muted@example.com";
    const blocker = "boost-hidden-blocker@example.com";
    const shown = "boost-hidden-shown@example.com";
    const memberId = await followLocal(owner, member);
    const listId = await createList(owner);
    await addMembers(owner, listId, [memberId]);

    const ownerPost = await post(owner, "owner post");
    for (const email of [blocked, muted, blocker, shown]) {
      await reblog(member, (await post(email, `${email.split("@")[0]} post`)).id);
    }
    await reblog(member, ownerPost.id);
    const ownerId = (await signedInAccount(owner)).id;
    for (const [email, path] of [
      [owner, `/api/v1/accounts/${(await signedInAccount(blocked)).id}/block`],
      [owner, `/api/v1/accounts/${(await signedInAccount(muted)).id}/mute`],
      [blocker, `/api/v1/accounts/${ownerId}/block`],
    ] as const) {
      expect((await send(email, path, "POST", {})).status).toBe(200);
    }

    const kept = ["boost:owner post", "boost:boost-hidden-shown post"];
    expect(await boosts(owner, "/api/v1/timelines/home")).toEqual(kept);
    expect(await boosts(owner, `/api/v1/timelines/list/${listId}`)).toEqual(kept);
  });

  it("stay off home and the list when the owner blocks or mutes the remote boosted author or its domain", async () => {
    const owner = "boost-rhidden-owner@example.com";
    const member = "boost-rhidden-member@example.com";
    const blockedRemote = await remoteActor("boost-hidden-rblocked", "boost-rblocked.example");
    const mutedRemote = await remoteActor("boost-hidden-rmuted", "boost-rmuted.example");
    const domainRemote = await remoteActor("boost-hidden-rdomain", "boost-rdomain.example");
    const shownRemote = await remoteActor("boost-hidden-rshown", "boost-rshown.example");
    const memberId = await followLocal(owner, member);
    const listId = await createList(owner);
    await addMembers(owner, listId, [memberId]);

    for (const remote of [blockedRemote, mutedRemote, domainRemote, shownRemote]) {
      const slug = new URL(remote.actorUri).hostname.split(".")[0] ?? "";
      await reblog(member, await cachedId(await note(remote, slug)));
    }
    for (const path of [
      `/api/v1/accounts/${remoteId(blockedRemote)}/block`,
      `/api/v1/accounts/${remoteId(mutedRemote)}/mute`,
    ]) {
      expect((await send(owner, path, "POST", {})).status).toBe(200);
    }
    expect(
      (await send(owner, "/api/v1/domain_blocks", "POST", { domain: "boost-rdomain.example" }))
        .status,
    ).toBe(200);

    const kept = ["boost:boost-rshown"];
    expect(await boosts(owner, "/api/v1/timelines/home")).toEqual(kept);
    expect(await boosts(owner, `/api/v1/timelines/list/${listId}`)).toEqual(kept);
  });
});

describe("a follow's languages", () => {
  it("keep the same posts on home and on the list", async () => {
    const owner = "lang-list-owner@example.com";
    const member = "lang-list-member@example.com";
    const memberId = (await signedInAccount(member)).id;
    expect(
      (await send(owner, `/api/v1/accounts/${memberId}/follow`, "POST", { languages: ["en"] }))
        .status,
    ).toBe(200);
    const listId = await createList(owner);
    await addMembers(owner, listId, [memberId]);

    for (const [status, language] of [
      ["english post", "en"],
      ["french post", "fr"],
      ["unlabelled post", ""],
    ]) {
      expect((await send(member, "/api/v1/statuses", "POST", { status, language })).status).toBe(
        200,
      );
    }

    const kept = ["unlabelled post", "english post"];
    expect(await labels(owner, "/api/v1/timelines/home")).toEqual(kept);
    expect(await labels(owner, `/api/v1/timelines/list/${listId}`)).toEqual(kept);
  });
});

const lock = async (email: string) =>
  expect(
    (await send(email, "/api/v1/accounts/update_credentials", "PATCH", { locked: true })).status,
  ).toBe(200);

const memberIds = async (email: string, listId: string): Promise<string[]> =>
  read(
    z.array(z.object({ id: z.string() })),
    (await get(email, `/api/v1/lists/${listId}/accounts`)).body,
  ).map((account) => account.id);

describe("a list's local members", () => {
  it("must be followed or requested, as Mastodon's ListAccount requires", async () => {
    const owner = "member-rule-owner@example.com";
    const stranger = "member-rule-stranger@example.com";
    const locked = "member-rule-locked@example.com";
    const ownerId = (await signedInAccount(owner)).id;
    const strangerId = (await signedInAccount(stranger)).id;
    await lock(locked);
    const lockedId = await followLocal(owner, locked);
    const listId = await createList(owner);

    const refused = await send(owner, `/api/v1/lists/${listId}/accounts`, "POST", {
      account_ids: [lockedId, strangerId],
    });
    expect(refused).toEqual({
      status: 422,
      body: { error: "Validation failed: Account must be a followed account", kind: "NotFollowed" },
    });
    expect(await memberIds(owner, listId)).toEqual([]);

    await addMembers(owner, listId, [lockedId, ownerId]);
    expect((await memberIds(owner, listId)).toSorted()).toEqual([lockedId, ownerId].toSorted());
  });

  it("leave the owner's lists when the follow ends", async () => {
    const owner = "member-leave-owner@example.com";
    const unfollowed = "member-leave-unfollowed@example.com";
    const removing = "member-leave-removing@example.com";
    const rejecting = "member-leave-rejecting@example.com";
    const kept = "member-leave-kept@example.com";
    await lock(rejecting);
    const ids = [
      await followLocal(owner, unfollowed),
      await followLocal(owner, removing),
      await followLocal(owner, rejecting),
      await followLocal(owner, kept),
    ];
    const [unfollowedId, , , keptId] = ids;
    const lists = [await createList(owner), await createList(owner)];
    for (const listId of lists) {
      await addMembers(owner, listId, ids);
    }

    const ownerId = (await signedInAccount(owner)).id;
    for (const [email, path] of [
      [owner, `/api/v1/accounts/${unfollowedId}/unfollow`],
      [removing, `/api/v1/accounts/${ownerId}/remove_from_followers`],
      [rejecting, `/api/v1/follow_requests/${ownerId}/reject`],
    ] as const) {
      expect((await send(email, path, "POST", {})).status).toBe(200);
    }
    await followLocal(owner, unfollowed);

    for (const listId of lists) {
      expect(await memberIds(owner, listId)).toEqual([keptId]);
    }
  });

  it("show posts on the list only while followed, as the list stream delivers them", async () => {
    const owner = "member-feed-owner@example.com";
    const stranger = "member-feed-stranger@example.com";
    const requested = "member-feed-requested@example.com";
    const followed = "member-feed-followed@example.com";
    await lock(requested);
    const requestedId = await followLocal(owner, requested);
    const followedId = await followLocal(owner, followed);
    const strangerId = (await signedInAccount(stranger)).id;
    const listId = await createList(owner);
    await addMembers(owner, listId, [requestedId, followedId]);
    // A membership stored before members had to be followed.
    await env.DB.prepare(
      "INSERT INTO account_list_members (list_id, member_account_id, created_at) VALUES (?, ?, ?)",
    )
      .bind(listId, strangerId, "2026-11-01T00:00:00.000Z")
      .run();

    for (const email of [stranger, requested, followed]) {
      await post(email, `${email.split("@")[0]} post`);
      const hidden = await send(email, "/api/v1/statuses", "POST", {
        status: `${email.split("@")[0]} private`,
        visibility: "private",
      });
      expect(hidden.status).toBe(200);
    }

    expect(await labels(owner, `/api/v1/timelines/list/${listId}`)).toEqual([
      "member-feed-followed private",
      "member-feed-followed post",
    ]);
  });
});

describe("a list's replies policy", () => {
  it("keeps local replies by policy, always passing self-replies and replies to the owner", async () => {
    const owner = "reply-local-owner@example.com";
    const member = "reply-local-member@example.com";
    const fellow = "reply-local-fellow@example.com";
    const followed = "reply-local-followed@example.com";
    const stranger = "reply-local-stranger@example.com";
    const memberId = await followLocal(owner, member);
    const fellowId = await followLocal(owner, fellow);
    await followLocal(owner, followed);
    const listId = await createList(owner);
    await addMembers(owner, listId, [memberId, fellowId]);

    const memberRoot = await post(member, "member root");
    const fellowRoot = await post(fellow, "fellow root");
    const followedRoot = await post(followed, "followed root");
    const strangerRoot = await post(stranger, "stranger root");
    const ownerRoot = await post(owner, "owner root");
    await post(member, "reply to self", memberRoot);
    await post(member, "reply to owner", ownerRoot);
    await post(member, "reply to fellow", fellowRoot);
    await post(member, "reply to followed", followedRoot);
    await post(member, "reply to stranger", strangerRoot);

    const path = `/api/v1/timelines/list/${listId}`;
    const replies = async () =>
      (await labels(owner, path)).filter((label) => label.startsWith("reply")).toSorted();

    await setList(owner, listId, { replies_policy: "none" });
    expect(await replies()).toEqual(["reply to owner", "reply to self"]);
    await setList(owner, listId, { replies_policy: "followed" });
    expect(await replies()).toEqual([
      "reply to fellow",
      "reply to followed",
      "reply to owner",
      "reply to self",
    ]);
    await setList(owner, listId, { replies_policy: "list" });
    expect(await replies()).toEqual(["reply to fellow", "reply to owner", "reply to self"]);
  });

  it("keeps remote replies by policy, counting replies to this instance's posts", async () => {
    const owner = "reply-remote-owner@example.com";
    const lister = "reply-remote-lister@example.com";
    const followed = "reply-remote-followed@example.com";
    const stranger = "reply-remote-stranger@example.com";
    const member = await remoteActor("reply-remote-member", "reply-member.example");
    const followedRemote = await remoteActor("reply-remote-followed", "reply-followed.example");
    const strangerRemote = await remoteActor("reply-remote-stranger", "reply-stranger.example");
    await followRemote(owner, member, "reply-remote-member");
    await followRemote(owner, followedRemote, "reply-remote-followed");
    const listerId = await followLocal(owner, lister);
    await followLocal(owner, followed);
    const listId = await createList(owner);
    await addMembers(owner, listId, [remoteId(member), listerId]);

    const listerPost = await post(lister, "lister post");
    const followedPost = await post(followed, "followed post");
    const strangerPost = await post(stranger, "stranger post");
    const ownerPost = await post(owner, "owner post");
    const followedNote = await note(followedRemote, "followed-note");
    const strangerNote = await note(strangerRemote, "stranger-note");
    const root = await note(member, "r-root");
    await note(member, "r-to-self", { inReplyTo: root });
    await note(member, "r-to-owner", { inReplyTo: ownerPost.uri });
    await note(member, "r-to-lister", { inReplyTo: listerPost.uri });
    await note(member, "r-to-followed-local", { inReplyTo: followedPost.uri });
    await note(member, "r-to-followed-remote", { inReplyTo: followedNote });
    await note(member, "r-to-stranger-local", { inReplyTo: strangerPost.uri });
    await note(member, "r-to-stranger-remote", { inReplyTo: strangerNote });

    const path = `/api/v1/timelines/list/${listId}`;
    const replies = async () =>
      (await labels(owner, path)).filter((label) => label.startsWith("r-")).toSorted();

    await setList(owner, listId, { replies_policy: "none" });
    expect(await replies()).toEqual(["r-root", "r-to-owner", "r-to-self"]);
    await setList(owner, listId, { replies_policy: "followed" });
    expect(await replies()).toEqual([
      "r-root",
      "r-to-followed-local",
      "r-to-followed-remote",
      "r-to-lister",
      "r-to-owner",
      "r-to-self",
    ]);
    await setList(owner, listId, { replies_policy: "list" });
    expect(await replies()).toEqual(["r-root", "r-to-lister", "r-to-owner", "r-to-self"]);
  });
});
