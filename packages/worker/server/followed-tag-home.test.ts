import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { openStream } from "../test/stream-fixture";
import { RemoteAccountId } from "./remote-account-id";

/**
 * A followed hashtag brings posts to the follower's home, as Mastodon's
 * `FanOutOnWriteService#deliver_to_hashtag_followers` and
 * `FeedManager#filter_from_tags?`: public posts only, no boosts, none from
 * the follower, from an author it blocks or mutes, from a domain it blocks or
 * an account the instance limits, and none that came before the follow.
 */

const ORIGIN = "https://example.com";
const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const api = async (email: string, path: string, init: RequestInit = {}) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
  });
  return { status: response.status, body: await response.json() };
};

const Entry = z.object({
  id: z.string(),
  uri: z.string(),
  reblog: z.object({ uri: z.string() }).nullable(),
});

const homeUris = async (email: string): Promise<string[]> =>
  read(z.array(Entry), (await api(email, "/api/v1/timelines/home?limit=40")).body).map(
    (entry) => entry.reblog?.uri ?? entry.uri,
  );

const followTag = async (email: string, tag: string): Promise<void> => {
  expect(
    (await api(email, `/api/v1/tags/${tag}/follow`, { method: "POST", body: "{}" })).status,
  ).toBe(200);
};

const post = async (
  email: string,
  status: string,
  visibility: "public" | "unlisted" | "private" = "public",
) => {
  const posted = await api(email, "/api/v1/statuses", {
    method: "POST",
    body: JSON.stringify({ status, visibility }),
  });
  expect(posted.status).toBe(200);
  return read(Entry, posted.body);
};

const remoteNote = (remote: Remote, slug: string, tag: string, to: string[], cc: string[]) => ({
  id: `${new URL(remote.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: remote.actorUri,
  content: `<p>about <a href="https://tagged.example/tags/${tag}" rel="tag">#<span>${tag}</span></a></p>`,
  tag: [{ type: "Hashtag", name: `#${tag}`, href: `https://tagged.example/tags/${tag}` }],
  published: new Date().toISOString(),
  to,
  cc,
});

const deliver = async (remote: Remote, note: ReturnType<typeof remoteNote>): Promise<void> => {
  expect(
    await remote.send({ id: `${note.id}/activity`, type: "Create", to: note.to, object: note }),
  ).toBe(202);
};

describe("a followed hashtag on the home timeline", () => {
  it("brings a stranger's public local post, not an unlisted, followers-only or earlier one", async () => {
    const reader = "ftag-local-reader@example.com";
    const author = "ftag-local-author@example.com";
    const earlier = await post(author, "#ftaglocal before the follow");
    await followTag(reader, "ftaglocal");
    const shown = await post(author, "public #FTagLocal");
    const unlisted = await post(author, "unlisted #ftaglocal", "unlisted");
    const followersOnly = await post(author, "private #ftaglocal", "private");
    const untagged = await post(author, "no tag here");

    const home = await homeUris(reader);
    expect(home).toContain(shown.uri);
    for (const hidden of [earlier, unlisted, followersOnly, untagged]) {
      expect(home).not.toContain(hidden.uri);
    }

    expect(
      (await api(reader, "/api/v1/tags/ftaglocal/unfollow", { method: "POST", body: "{}" })).status,
    ).toBe(200);
    expect(await homeUris(reader)).not.toContain(shown.uri);
  });

  it("leaves out a muted or blocked author, a boost, and a post that is also followed", async () => {
    const reader = "ftag-filter-reader@example.com";
    const muted = "ftag-filter-muted@example.com";
    const blocked = "ftag-filter-blocked@example.com";
    const followed = "ftag-filter-followed@example.com";
    const booster = "ftag-filter-booster@example.com";
    for (const [target, action] of [
      [muted, "mute"],
      [blocked, "block"],
      [followed, "follow"],
    ] as const) {
      const account = await signedInAccount(target);
      expect(
        (
          await api(reader, `/api/v1/accounts/${account.id}/${action}`, {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(200);
    }
    await followTag(reader, "ftagfilter");
    const fromMuted = await post(muted, "muted #ftagfilter");
    const fromBlocked = await post(blocked, "blocked #ftagfilter");
    const fromFollowed = await post(followed, "followed #ftagfilter");
    const own = await post(reader, "mine #ftagfilter");
    const original = await post(followed, "boost me, untagged");
    expect(
      (await api(booster, `/api/v1/statuses/${original.id}/reblog`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(200);

    const home = await homeUris(reader);
    expect(home).not.toContain(fromMuted.uri);
    expect(home).not.toContain(fromBlocked.uri);
    expect(home.filter((uri) => uri === fromFollowed.uri)).toHaveLength(1);
    expect(home.filter((uri) => uri === own.uri)).toHaveLength(1);
  });

  it("brings a public remote post as it arrives, not an unlisted one or one from a muted actor", async () => {
    const reader = "ftag-remote-reader@example.com";
    await followTag(reader, "ftagremote");
    const remote = await remoteActor("ftag-poster", "tagged.example");
    const muted = await remoteActor("ftag-muted", "tagged.example");
    const mutedId = RemoteAccountId.encode(muted.actorUri);
    expect(
      (await api(reader, `/api/v1/accounts/${mutedId}/mute`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(200);

    const followers = `${remote.actorUri}/followers`;
    const shown = remoteNote(remote, "ftag-public", "ftagremote", [PUBLIC], [followers]);
    const unlisted = remoteNote(remote, "ftag-unlisted", "ftagremote", [followers], [PUBLIC]);
    const fromMuted = remoteNote(muted, "ftag-muted", "ftagremote", [PUBLIC], [followers]);
    for (const [author, note] of [
      [remote, shown],
      [remote, unlisted],
      [muted, fromMuted],
    ] as const) {
      await deliver(author, note);
    }

    const home = await homeUris(reader);
    expect(home).toContain(shown.id);
    expect(home).not.toContain(unlisted.id);
    expect(home).not.toContain(fromMuted.id);
  });

  it("streams a new tagged post to the follower's user stream", async () => {
    const reader = "ftag-stream-reader@example.com";
    const author = "ftag-stream-author@example.com";
    await followTag(reader, "ftagstream");
    const stream = await openStream({ email: reader, query: "?stream=user" });
    const sent = await post(author, "streamed #ftagstream");
    const heard = await stream.next();
    expect(heard.event).toBe("update");
    expect(read(Entry, JSON.parse(heard.payload)).uri).toBe(sent.uri);
    stream.close();
  });

  it("keeps a post on the page when a muted author floods its hashtag after it", async () => {
    const reader = "ftag-flood-reader@example.com";
    const spammer = "ftag-flood-spammer@example.com";
    await followTag(reader, "ftagflood");
    const spammerAccount = await signedInAccount(spammer);
    const remoteSpammer = await remoteActor("ftag-flood-spam", "tagged.example");
    const remotePoster = await remoteActor("ftag-flood-poster", "tagged.example");
    for (const target of [spammerAccount.id, RemoteAccountId.encode(remoteSpammer.actorUri)]) {
      expect(
        (await api(reader, `/api/v1/accounts/${target}/mute`, { method: "POST", body: "{}" }))
          .status,
      ).toBe(200);
    }
    const local = await post("ftag-flood-author@example.com", "worth reading #ftagflood");
    const followers = `${remotePoster.actorUri}/followers`;
    const remote = remoteNote(remotePoster, "ftag-flood-worth", "ftagflood", [PUBLIC], [followers]);
    await deliver(remotePoster, remote);
    for (let n = 0; n < 25; n += 1) {
      await post(spammer, `spam ${n} #ftagflood`);
      await deliver(
        remoteSpammer,
        remoteNote(
          remoteSpammer,
          `ftag-flood-spam-${n}`,
          "ftagflood",
          [PUBLIC],
          [`${remoteSpammer.actorUri}/followers`],
        ),
      );
    }

    const home = read(
      z.array(Entry),
      (await api(reader, "/api/v1/timelines/home?limit=20")).body,
    ).map((entry) => entry.uri);
    expect(home).toEqual([remote.id, local.uri]);
  });

  it("reads past a hidden flood deeper than a page reads, rather than answer an empty page", async () => {
    const reader = "ftag-deep-reader@example.com";
    const spammer = "ftag-deep-spammer@example.com";
    await followTag(reader, "ftagdeep");
    const spammerAccount = await signedInAccount(spammer);
    expect(
      (
        await api(reader, `/api/v1/accounts/${spammerAccount.id}/mute`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(200);
    const worth = await post("ftag-deep-author@example.com", "worth reading #ftagdeep");
    for (let n = 0; n < 90; n += 1) {
      await post(spammer, `spam ${n} #ftagdeep`);
    }

    const home = read(z.array(Entry), (await api(reader, "/api/v1/timelines/home?limit=20")).body);
    expect(home.map((entry) => entry.uri)).toEqual([worth.uri]);
  });

  it("pages through the posts of several followed hashtags, older and newer", async () => {
    const reader = "ftag-page-reader@example.com";
    const tags = ["ftagpagea", "ftagpageb", "ftagpagec"];
    for (const tag of tags) {
      await followTag(reader, tag);
    }
    const posted: string[] = [];
    for (let n = 0; n < 9; n += 1) {
      posted.push((await post("ftag-page-author@example.com", `${n} #${tags[n % 3]}`)).id);
    }
    const page = async (query: string): Promise<string[]> =>
      read(z.array(Entry), (await api(reader, `/api/v1/timelines/home?limit=2${query}`)).body).map(
        (entry) => entry.id,
      );
    const pairs = (ids: string[]): string[][] =>
      Array.from({ length: Math.ceil(ids.length / 2) }, (_, n) => ids.slice(2 * n, 2 * n + 2));

    const older: string[][] = [];
    for (let maxId = ""; older.flat().length < posted.length;) {
      const ids = await page(maxId === "" ? "" : `&max_id=${maxId}`);
      if (ids.length === 0) break;
      older.push(ids);
      maxId = ids.at(-1) ?? "";
    }
    expect(older).toEqual(pairs(posted.toReversed()));

    const newer: string[][] = [];
    for (let minId = "0"; newer.flat().length < posted.length;) {
      const ids = await page(`&min_id=${minId}`);
      if (ids.length === 0) break;
      newer.push(ids);
      minId = ids[0] ?? "";
    }
    expect(newer).toEqual(pairs(posted).map((pair) => pair.toReversed()));
  });

  it("brings the posts of every followed hashtag, however many the reader follows", async () => {
    const reader = "ftag-many-reader@example.com";
    await followTag(reader, "ftagmanyfirst");
    for (let n = 0; n < 30; n += 1) {
      await followTag(reader, `ftagmany${n}`);
    }
    const stream = await openStream({ email: reader, query: "?stream=user" });
    const local = await post("ftag-many-author@example.com", "the first one #ftagmanyfirst");
    const heard = await stream.next();
    stream.close();
    expect(heard.event).toBe("update");
    expect(read(Entry, JSON.parse(heard.payload)).uri).toBe(local.uri);
    const remote = await remoteActor("ftag-many-poster", "tagged.example");
    const note = remoteNote(
      remote,
      "ftag-many",
      "ftagmanyfirst",
      [PUBLIC],
      [`${remote.actorUri}/followers`],
    );
    await deliver(remote, note);

    const home = await homeUris(reader);
    expect(home).toContain(local.uri);
    expect(home).toContain(note.id);
  });
});
