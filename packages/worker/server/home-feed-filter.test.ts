import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon v4.7.5's `FeedManager#filter_from_home` (home and, through
// `filter(:list)`, lists) and `#filter_from_tags?` (a followed hashtag's
// posts), for the rules tstodon's home queries did not apply: a status that
// mentions an account the viewer blocks or mutes, a boost of one, and a reply
// to an account the viewer does not follow.

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const HOST = "home-filter.example";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const call = async (email: string, path: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

const Entry = z.object({ id: z.string(), reblog: z.object({ id: z.string() }).nullable() });

const idsIn = async (email: string, path: string): Promise<string[]> =>
  read(z.array(Entry), await call(email, path)).map((entry) => entry.id);

const homeIds = (email: string): Promise<string[]> =>
  idsIn(email, "/api/v1/timelines/home?limit=40");

const post = async (
  email: string,
  status: string,
  options: Readonly<{ inReplyToId?: string; language?: string }> = {},
): Promise<string> =>
  read(
    Entry,
    await call(email, "/api/v1/statuses", {
      method: "POST",
      body: JSON.stringify({
        status,
        visibility: "public",
        ...(options.inReplyToId === undefined ? {} : { in_reply_to_id: options.inReplyToId }),
        ...(options.language === undefined ? {} : { language: options.language }),
      }),
    }),
  ).id;

const boost = async (email: string, statusId: string): Promise<string> =>
  read(Entry, await call(email, `/api/v1/statuses/${statusId}/reblog`, { method: "POST" })).id;

const act = async (
  email: string,
  targetId: string,
  action: "follow" | "block" | "mute" | "unblock" | "unmute",
  body: Record<string, unknown> = {},
): Promise<void> => {
  await call(email, `/api/v1/accounts/${targetId}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
};

const rowId = async (sql: string, bind: string): Promise<string> => {
  const [row] = parseRows(
    z.object({ id: z.string() }),
    (await env.DB.prepare(sql).bind(bind).all()).results,
  );
  if (!row) {
    throw new Error(`no row for ${bind}`);
  }
  return row.id;
};

/** Follow `remote` as `email`, and have it accept. */
const followRemote = async (email: string, remote: Remote): Promise<void> => {
  await act(email, RemoteAccountId.encode(remote.actorUri), "follow");
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

const noteUri = (remote: Remote, slug: string): string =>
  `${new URL(remote.actorUri).origin}/notes/${slug}`;

/** A public note `remote` sends; its stored id. */
const sendNote = async (
  remote: Remote,
  slug: string,
  options: Readonly<{
    mentions?: string[];
    /** Addressed in `cc` without a `Mention` tag: a silent mention. */
    addressed?: string[];
    inReplyTo?: string;
    hashtag?: string;
  }> = {},
): Promise<string> => {
  const id = noteUri(remote, slug);
  const hashtag = options.hashtag;
  expect(
    await remote.send({
      id: `${id}/create`,
      type: "Create",
      to: [PUBLIC],
      object: {
        id,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${slug}${hashtag === undefined ? "" : ` #${hashtag}`}</p>`,
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [
          `${remote.actorUri}/followers`,
          ...(options.mentions ?? []),
          ...(options.addressed ?? []),
        ],
        ...(options.inReplyTo === undefined ? {} : { inReplyTo: options.inReplyTo }),
        tag: [
          ...(options.mentions ?? []).map((href) => ({ type: "Mention", href })),
          ...(hashtag === undefined
            ? []
            : [{ type: "Hashtag", name: `#${hashtag}`, href: `https://${HOST}/tags/${hashtag}` }]),
        ],
      },
    }),
  ).toBe(202);
  return rowId("SELECT id FROM remote_statuses WHERE object_uri = ?", id);
};

/** The account signed in as `email`, with that email to act as it. */
const user = async (email: string) => {
  const account = await signedInAccount(email);
  return { email, id: account.id, username: account.username };
};

const localActor = (username: string): string => `${ORIGIN}/users/${username}`;

describe("home leaves out a status that mentions an account the viewer blocks or mutes", () => {
  it("for a followed local author's post, a block, a mute and a mute without notifications", async () => {
    const viewer = "hff-mention-viewer@example.com";
    const author = await user("hff-mention-author@example.com");
    const blocked = await user("hff-mention-blocked@example.com");
    const muted = await user("hff-mention-muted@example.com");
    const quiet = await user("hff-mention-quiet@example.com");
    await user(viewer);
    await act(viewer, author.id, "follow");
    const toBlocked = await post(author.email, `@${blocked.username} hello`);
    const toMuted = await post(author.email, `@${muted.username} hello`);
    const toQuiet = await post(author.email, `@${quiet.username} hello`);
    const plain = await post(author.email, "no mentions");
    expect(await homeIds(viewer)).toEqual(expect.arrayContaining([toBlocked, toMuted, toQuiet]));

    await act(viewer, blocked.id, "block");
    await act(viewer, muted.id, "mute");
    await act(viewer, quiet.id, "mute", { notifications: false });

    const home = await homeIds(viewer);
    expect(home).toContain(plain);
    for (const hidden of [toBlocked, toMuted, toQuiet]) {
      expect(home).not.toContain(hidden);
    }
  });

  it("keeps the viewer's own post that mentions an account it blocks", async () => {
    const viewer = await user("hff-own-viewer@example.com");
    const blocked = await user("hff-own-blocked@example.com");
    const own = await post(viewer.email, `@${blocked.username} before the block`);
    await act(viewer.email, blocked.id, "block");

    expect(await homeIds(viewer.email)).toContain(own);
  });

  it("for a local boost of a post that mentions a muted account", async () => {
    const viewer = "hff-boost-viewer@example.com";
    const booster = await user("hff-boost-booster@example.com");
    const author = await user("hff-boost-author@example.com");
    const muted = await user("hff-boost-muted@example.com");
    await user(viewer);
    await act(viewer, booster.id, "follow");
    const original = await post(author.email, `@${muted.username} boost this`);
    const reblog = await boost(booster.email, original);
    expect(await homeIds(viewer)).toContain(reblog);

    await act(viewer, muted.id, "mute");

    expect(await homeIds(viewer)).not.toContain(reblog);
  });

  it("on a list as well", async () => {
    const viewer = "hff-list-viewer@example.com";
    const member = await user("hff-list-member@example.com");
    const blocked = await user("hff-list-blocked@example.com");
    await user(viewer);
    await act(viewer, member.id, "follow");
    const list = read(
      z.object({ id: z.string() }),
      await call(viewer, "/api/v1/lists", { method: "POST", body: JSON.stringify({ title: "m" }) }),
    ).id;
    await call(viewer, `/api/v1/lists/${list}/accounts`, {
      method: "POST",
      body: JSON.stringify({ account_ids: [member.id] }),
    });
    const mention = await post(member.email, `@${blocked.username} on the list`);
    const plain = await post(member.email, "plain on the list");
    await act(viewer, blocked.id, "block");

    const shown = await idsIn(viewer, `/api/v1/timelines/list/${list}`);
    expect(shown).toContain(plain);
    expect(shown).not.toContain(mention);
  });

  it("for a followed hashtag's post", async () => {
    const viewer = "hff-tag-viewer@example.com";
    const author = await user("hff-tag-author@example.com");
    const muted = await user("hff-tag-muted@example.com");
    await user(viewer);
    await call(viewer, "/api/v1/tags/hfftagged/follow", { method: "POST", body: "{}" });
    await act(viewer, muted.id, "mute");
    const mention = await post(author.email, `@${muted.username} #hfftagged`);
    const plain = await post(author.email, "plain #hfftagged");

    const home = await homeIds(viewer);
    expect(home).toContain(plain);
    expect(home).not.toContain(mention);
  });

  it("for a followed remote actor's note, a remote boost, and a followed hashtag's remote note", async () => {
    const viewer = "hff-remote-viewer@example.com";
    const blocked = await user("hff-remote-blocked@example.com");
    const followed = await remoteActor("hffremotefollowed", HOST);
    const mutedActor = await remoteActor("hffremotemuted", HOST);
    const stranger = await remoteActor("hffremotestranger", HOST);
    await user(viewer);
    await followRemote(viewer, followed);
    await call(viewer, "/api/v1/tags/hffremotetag/follow", { method: "POST", body: "{}" });

    const toLocal = await sendNote(followed, "hff-to-local", {
      mentions: [localActor(blocked.username)],
    });
    const toRemote = await sendNote(followed, "hff-to-remote", {
      mentions: [mutedActor.actorUri],
    });
    const plain = await sendNote(followed, "hff-plain");
    const tagged = await sendNote(stranger, "hff-tagged", {
      mentions: [mutedActor.actorUri],
      hashtag: "hffremotetag",
    });
    const taggedPlain = await sendNote(stranger, "hff-tagged-plain", { hashtag: "hffremotetag" });
    await sendNote(stranger, "hff-boosted", { mentions: [localActor(blocked.username)] });
    const announceId = `${followed.actorUri}/announces/hff-boost`;
    expect(
      await followed.send({
        id: announceId,
        type: "Announce",
        object: noteUri(stranger, "hff-boosted"),
        published: new Date().toISOString(),
        to: [PUBLIC],
        cc: [`${followed.actorUri}/followers`],
      }),
    ).toBe(202);
    const boostId = await rowId("SELECT id FROM remote_boosts WHERE activity_id = ?", announceId);
    expect(await homeIds(viewer)).toEqual(
      expect.arrayContaining([toLocal, toRemote, tagged, boostId]),
    );

    await act(viewer, blocked.id, "block");
    await act(viewer, RemoteAccountId.encode(mutedActor.actorUri), "mute");

    const home = await homeIds(viewer);
    expect(home).toEqual(expect.arrayContaining([plain, taggedPlain]));
    for (const hidden of [toLocal, toRemote, tagged, boostId]) {
      expect(home).not.toContain(hidden);
    }
  });
});

describe("home leaves out a reply to an account the viewer does not follow", () => {
  it("for a followed local author, unless it answers the viewer, itself or a followed account", async () => {
    const viewer = await user("hff-reply-viewer@example.com");
    const author = await user("hff-reply-author@example.com");
    const stranger = await user("hff-reply-stranger@example.com");
    const friend = await user("hff-reply-friend@example.com");
    await act(viewer.email, author.id, "follow");
    await act(viewer.email, friend.id, "follow");
    const strangerPost = await post(stranger.email, "a stranger speaks");
    const viewerPost = await post(viewer.email, "the viewer speaks");
    const friendPost = await post(friend.email, "a friend speaks");
    const authorPost = await post(author.email, "the author speaks");

    const toStranger = await post(author.email, "to the stranger", { inReplyToId: strangerPost });
    const toViewer = await post(author.email, "to the viewer", { inReplyToId: viewerPost });
    const toFriend = await post(author.email, "to the friend", { inReplyToId: friendPost });
    const toSelf = await post(author.email, "to itself", { inReplyToId: authorPost });
    const ownToStranger = await post(viewer.email, "mine", { inReplyToId: strangerPost });

    const home = await homeIds(viewer.email);
    expect(home).toEqual(expect.arrayContaining([toViewer, toFriend, toSelf, ownToStranger]));
    expect(home).not.toContain(toStranger);

    await act(viewer.email, stranger.id, "follow");
    expect(await homeIds(viewer.email)).toContain(toStranger);
  });

  it("but a followed hashtag still brings such a reply", async () => {
    const viewer = "hff-tagreply-viewer@example.com";
    const author = await user("hff-tagreply-author@example.com");
    const stranger = await user("hff-tagreply-stranger@example.com");
    await user(viewer);
    await call(viewer, "/api/v1/tags/hfftagreply/follow", { method: "POST", body: "{}" });
    const strangerPost = await post(stranger.email, "a stranger speaks");
    const reply = await post(author.email, "#hfftagreply answer", { inReplyToId: strangerPost });

    expect(await homeIds(viewer)).toContain(reply);
  });

  it("for a followed remote actor, unless it answers the viewer, itself or a followed actor", async () => {
    const viewer = await user("hff-rreply-viewer@example.com");
    const followed = await remoteActor("hffrreplyfollowed", HOST);
    const friend = await remoteActor("hffrreplyfriend", HOST);
    const stranger = await remoteActor("hffrreplystranger", HOST);
    const localStranger = await user("hff-rreply-localstranger@example.com");
    await followRemote(viewer.email, followed);
    await followRemote(viewer.email, friend);
    await sendNote(stranger, "hff-r-stranger");
    await sendNote(friend, "hff-r-friend");
    await sendNote(followed, "hff-r-own");
    const viewerPost = await post(viewer.email, "the viewer speaks");
    const localStrangerPost = await post(localStranger.email, "a local stranger speaks");

    const toStranger = await sendNote(followed, "hff-r-to-stranger", {
      inReplyTo: noteUri(stranger, "hff-r-stranger"),
    });
    const toLocalStranger = await sendNote(followed, "hff-r-to-local-stranger", {
      inReplyTo: `${localActor(localStranger.username)}/statuses/${localStrangerPost}`,
    });
    const toFriend = await sendNote(followed, "hff-r-to-friend", {
      inReplyTo: noteUri(friend, "hff-r-friend"),
    });
    const toSelf = await sendNote(followed, "hff-r-to-self", {
      inReplyTo: noteUri(followed, "hff-r-own"),
    });
    const toViewer = await sendNote(followed, "hff-r-to-viewer", {
      inReplyTo: `${localActor(viewer.username)}/statuses/${viewerPost}`,
    });

    const home = await homeIds(viewer.email);
    expect(home).toEqual(expect.arrayContaining([toFriend, toSelf, toViewer]));
    expect(home).not.toContain(toStranger);
    expect(home).not.toContain(toLocalStranger);
  });

  it("and the home stream does not hear it", async () => {
    const viewer = "hff-stream-viewer@example.com";
    const author = await user("hff-stream-author@example.com");
    const stranger = await user("hff-stream-stranger@example.com");
    await user(viewer);
    await act(viewer, author.id, "follow");
    const strangerPost = await post(stranger.email, "a stranger speaks");
    const stream = await openStream({ email: viewer, query: "?stream=user" });
    try {
      await post(author.email, "to the stranger", { inReplyToId: strangerPost });
      const plain = await post(author.email, "to everyone");

      const heard = await stream.next();
      expect(heard.event).toBe("update");
      expect(read(z.object({ id: z.string() }), JSON.parse(heard.payload)).id).toBe(plain);
    } finally {
      stream.close();
    }
  });
});

describe("a followed hashtag brings what the follow path leaves out", () => {
  // `filter_from_tags?` has no exclusive-list and no reply rule, and
  // `FeedInsertWorker` pushes to home when either path passes.
  const exclusiveList = async (email: string, body: Record<string, unknown>): Promise<void> => {
    const list = read(
      z.object({ id: z.string() }),
      await call(email, "/api/v1/lists", {
        method: "POST",
        body: JSON.stringify({ title: "exclusive", exclusive: true }),
      }),
    ).id;
    await call(email, `/api/v1/lists/${list}/accounts`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  };

  it("a local member of an exclusive list posting under it", async () => {
    const viewer = "hff-excl-viewer@example.com";
    const member = await user("hff-excl-member@example.com");
    await user(viewer);
    await act(viewer, member.id, "follow");
    await exclusiveList(viewer, { account_ids: [member.id] });
    await call(viewer, "/api/v1/tags/hffexcltag/follow", { method: "POST", body: "{}" });
    const tagged = await post(member.email, "#hffexcltag on home");
    const untagged = await post(member.email, "list only");

    const home = await homeIds(viewer);
    expect(home).toContain(tagged);
    expect(home).not.toContain(untagged);
  });

  it("a local reply to a stranger and a post outside the follow's languages", async () => {
    const viewer = "hff-taglang-viewer@example.com";
    const author = await user("hff-taglang-author@example.com");
    const stranger = await user("hff-taglang-stranger@example.com");
    await user(viewer);
    await act(viewer, author.id, "follow", { languages: ["en"] });
    await call(viewer, "/api/v1/tags/hfftaglang/follow", { method: "POST", body: "{}" });
    const strangerPost = await post(stranger.email, "a stranger speaks");
    const taggedJa = await post(author.email, "#hfftaglang こんにちは", { language: "ja" });
    const plainJa = await post(author.email, "こんにちは", { language: "ja" });
    const taggedReply = await post(author.email, "#hfftaglang answer", {
      inReplyToId: strangerPost,
    });

    const home = await homeIds(viewer);
    expect(home).toEqual(expect.arrayContaining([taggedJa, taggedReply]));
    expect(home).not.toContain(plainJa);
  });

  it("a remote member of an exclusive list, and a followed actor's reply to a stranger", async () => {
    const viewer = "hff-rexcl-viewer@example.com";
    const member = await remoteActor("hffrexclmember", HOST);
    const followed = await remoteActor("hffrexclfollowed", HOST);
    const stranger = await remoteActor("hffrexclstranger", HOST);
    await user(viewer);
    await followRemote(viewer, member);
    await followRemote(viewer, followed);
    await exclusiveList(viewer, { account_ids: [RemoteAccountId.encode(member.actorUri)] });
    await call(viewer, "/api/v1/tags/hffrexcltag/follow", { method: "POST", body: "{}" });
    await sendNote(stranger, "hff-rexcl-stranger");
    const memberTagged = await sendNote(member, "hff-rexcl-member-tagged", {
      hashtag: "hffrexcltag",
    });
    const memberPlain = await sendNote(member, "hff-rexcl-member-plain");
    const replyTagged = await sendNote(followed, "hff-rexcl-reply-tagged", {
      inReplyTo: noteUri(stranger, "hff-rexcl-stranger"),
      hashtag: "hffrexcltag",
    });
    const replyPlain = await sendNote(followed, "hff-rexcl-reply-plain", {
      inReplyTo: noteUri(stranger, "hff-rexcl-stranger"),
    });
    const followedTagged = await sendNote(followed, "hff-rexcl-followed-tagged", {
      hashtag: "hffrexcltag",
    });

    const home = await homeIds(viewer);
    expect(home).toEqual(expect.arrayContaining([memberTagged, replyTagged, followedTagged]));
    expect(home).not.toContain(memberPlain);
    expect(home).not.toContain(replyPlain);
    expect(home.filter((id) => id === followedTagged)).toHaveLength(1);
  });
});

describe("a muted conversation", () => {
  // Mastodon's `ConversationMute` silences notifications only (`NotifyService`);
  // `FeedManager` never reads it, so home and lists keep the thread.
  it("stays on home and on a list, local and remote replies alike", async () => {
    const viewer = await user("hff-cmute-viewer@example.com");
    const author = await user("hff-cmute-author@example.com");
    const followed = await remoteActor("hffcmutefollowed", HOST);
    await act(viewer.email, author.id, "follow");
    await followRemote(viewer.email, followed);
    const list = read(
      z.object({ id: z.string() }),
      await call(viewer.email, "/api/v1/lists", {
        method: "POST",
        body: JSON.stringify({ title: "cmute" }),
      }),
    ).id;
    await call(viewer.email, `/api/v1/lists/${list}/accounts`, {
      method: "POST",
      body: JSON.stringify({ account_ids: [author.id] }),
    });
    const root = await post(viewer.email, "a thread I will mute");
    const localReply = await post(author.email, "a reply", { inReplyToId: root });
    const remoteReply = await sendNote(followed, "hff-cmute-reply", {
      inReplyTo: `${localActor(viewer.username)}/statuses/${root}`,
    });
    await call(viewer.email, `/api/v1/statuses/${root}/mute`, { method: "POST" });

    expect(await homeIds(viewer.email)).toEqual(
      expect.arrayContaining([root, localReply, remoteReply]),
    );
    expect(await idsIn(viewer.email, `/api/v1/timelines/list/${list}`)).toContain(localReply);
  });
});

describe("home's filter edges", () => {
  it("does not count an expired mute or a silent mention", async () => {
    const viewer = "hff-edge-viewer@example.com";
    const author = await user("hff-edge-author@example.com");
    const lapsed = await user("hff-edge-lapsed@example.com");
    const silent = await user("hff-edge-silent@example.com");
    const followed = await remoteActor("hffedgefollowed", HOST);
    const me = await user(viewer);
    await act(viewer, author.id, "follow");
    await followRemote(viewer, followed);
    const toLapsed = await post(author.email, `@${lapsed.username} hello`);
    const addressed = await sendNote(followed, "hff-edge-silent", {
      addressed: [localActor(silent.username)],
    });
    const [mention] = parseRows(
      z.object({ silent: z.number() }),
      (
        await env.DB.prepare(
          "SELECT silent FROM remote_status_mentions WHERE status_id = ? AND account_id = ?",
        )
          .bind(addressed, silent.id)
          .all()
      ).results,
    );
    expect(mention?.silent).toBe(1);

    await act(viewer, lapsed.id, "mute");
    await act(viewer, silent.id, "mute");
    await env.DB.prepare(
      "UPDATE mutes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE account_id = ? AND target_account_id = ?",
    )
      .bind(me.id, lapsed.id)
      .run();

    expect(await homeIds(viewer)).toEqual(expect.arrayContaining([toLapsed, addressed]));
  });

  it("keeps a local reply to a followed actor's note, and drops a remote reply to a note it does not hold", async () => {
    const viewer = "hff-held-viewer@example.com";
    const author = await user("hff-held-author@example.com");
    const followed = await remoteActor("hffheldfollowed", HOST);
    await user(viewer);
    await act(viewer, author.id, "follow");
    await followRemote(viewer, followed);
    const parent = await sendNote(followed, "hff-held-parent");
    const localReply = await post(author.email, "answering a followed actor", {
      inReplyToId: parent,
    });
    const orphan = await sendNote(followed, "hff-held-orphan", {
      inReplyTo: `https://unheld.example/notes/nowhere`,
    });

    const home = await homeIds(viewer);
    expect(home).toContain(localReply);
    expect(home).not.toContain(orphan);
  });
});
