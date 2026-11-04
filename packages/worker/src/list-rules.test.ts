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
  it("keep their members' posts and boosts off home, paged by id", async () => {
    const owner = "excl-owner@example.com";
    const member = "excl-member@example.com";
    const other = "excl-other@example.com";
    const remoteMember = await remoteActor("excl-remote-member", "excl-member.example");
    const remoteOther = await remoteActor("excl-remote-other", "excl-other.example");
    const memberId = await followLocal(owner, member);
    await followLocal(owner, other);
    await followRemote(owner, remoteMember, "excl-remote-member");
    await followRemote(owner, remoteOther, "excl-remote-other");
    const listId = await createList(owner, { exclusive: true });
    await addMembers(owner, listId, [memberId, remoteId(remoteMember)]);

    await post(member, "member post");
    const otherPost = await post(other, "other post");
    await reblog(member, otherPost.id);
    await note(remoteMember, "remote-member-note");
    const otherNote = await note(remoteOther, "remote-other-note");
    await announce(remoteMember, otherNote, "remote-member-boost");

    expect(await labels(owner, "/api/v1/timelines/home")).toEqual([
      "remote-other-note",
      "other post",
    ]);
    expect(await walk(owner, "/api/v1/timelines/home")).toEqual([
      "remote-other-note",
      "other post",
    ]);
    const { body } = await get(owner, "/api/v1/timelines/home?limit=1");
    const newest = read(z.array(StatusSchema), body)[0]?.id ?? "";
    expect(await labels(owner, `/api/v1/timelines/home?limit=1&max_id=${newest}`)).toEqual([
      "other post",
    ]);
    expect(await labels(owner, `/api/v1/timelines/list/${listId}`)).toEqual([
      "boost:remote-other-note",
      "remote-member-note",
      "member post",
    ]);

    await setList(owner, listId, { exclusive: false });
    expect(await walk(owner, "/api/v1/timelines/home")).toEqual([
      "boost:remote-other-note",
      "remote-other-note",
      "remote-member-note",
      "boost:other post",
      "other post",
      "member post",
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
    const fellowId = await signedInAccount(fellow).then((account) => account.id);
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
    expect(await replies()).toEqual(["reply to followed", "reply to owner", "reply to self"]);
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
    const listerId = await signedInAccount(lister).then((account) => account.id);
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
      "r-to-owner",
      "r-to-self",
    ]);
    await setList(owner, listId, { replies_policy: "list" });
    expect(await replies()).toEqual(["r-root", "r-to-lister", "r-to-owner", "r-to-self"]);
  });
});
