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

const accountId = (remote: Remote): string => RemoteAccountId.encode(remote.actorUri);

const acceptedFollow = async (email: string, remote: Remote, slug: string) => {
  const followed = await json(`/api/v1/accounts/${accountId(remote)}/follow`, {
    method: "POST",
    headers: { ...(await authHeaders(email)), "content-type": "application/json" },
    body: "{}",
  });
  expect(followed.status).toBe(200);
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

const boost = async (booster: Remote, objectUri: string, slug: string) =>
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

const EntrySchema = z.object({
  id: z.string(),
  uri: z.string(),
  account: z.object({ id: z.string() }),
  reblog: z.object({ uri: z.string() }).nullable(),
});

const statuses = async (remote: Remote, query = "", email?: string) => {
  const response = await json(
    `/api/v1/accounts/${accountId(remote)}/statuses${query}`,
    email ? { headers: await authHeaders(email) } : {},
  );
  expect(response.status).toBe(200);
  return read(z.array(EntrySchema), response.body);
};

/** Each entry as the URI a reader sees, a boost as `boost:` and the boosted URI. */
const uris = async (remote: Remote, query = "", email?: string): Promise<string[]> =>
  (await statuses(remote, query, email)).map((entry) =>
    entry.reblog ? `boost:${entry.reblog.uri}` : entry.uri,
  );

describe("a remote account's statuses", () => {
  it("lists its public notes and boosts for anyone, newest first, paged by id", async () => {
    const actor = await remoteActor("profile-public-actor", "profile.example");
    const other = await remoteActor("profile-public-other", "other.example");
    const first = await note(actor, "profile-public-first");
    const unlisted = await note(actor, "profile-public-unlisted", {
      to: [`${actor.actorUri}/followers`],
      cc: [PUBLIC],
    });
    const othersNote = await note(other, "profile-public-others");
    await boost(actor, othersNote, "profile-public-boost");

    expect(await uris(actor)).toEqual([`boost:${othersNote}`, unlisted, first]);
    const [newest, , oldest] = await statuses(actor);
    expect(newest?.account.id).toBe(accountId(actor));
    expect(await uris(actor, `?max_id=${newest?.id ?? ""}`)).toEqual([unlisted, first]);
    expect(await uris(actor, `?limit=1&min_id=${oldest?.id ?? ""}`)).toEqual([unlisted]);
    expect(await uris(actor, `?since_id=${oldest?.id ?? ""}`)).toEqual([
      `boost:${othersNote}`,
      unlisted,
    ]);
    expect(await uris(actor, "?exclude_reblogs=true")).toEqual([unlisted, first]);
    expect(await uris(actor, "?pinned=true")).toEqual([]);
  });

  it("shows followers-only notes to accepted followers and direct ones to who they mention", async () => {
    const actor = await remoteActor("profile-private-actor", "private.example");
    const follower = "profile-private-follower@example.com";
    const stranger = "profile-private-stranger@example.com";
    const mentioned = await signedInAccount("profile-private-mentioned@example.com");
    await signedInAccount(stranger);
    await acceptedFollow(follower, actor, "profile-private");
    const open = await note(actor, "profile-private-open");
    const followersOnly = await note(actor, "profile-private-followers", {
      to: [`${actor.actorUri}/followers`],
      cc: [],
    });
    const mentionedUri = `https://example.com/users/${mentioned.username}`;
    const direct = await note(actor, "profile-private-direct", {
      to: [mentionedUri],
      cc: [],
      tag: [{ type: "Mention", href: mentionedUri, name: `@${mentioned.username}@example.com` }],
    });
    const reply = await note(actor, "profile-private-reply", { inReplyTo: open });

    expect(await uris(actor)).toEqual([reply, open]);
    expect(await uris(actor, "", stranger)).toEqual([reply, open]);
    expect(await uris(actor, "", follower)).toEqual([reply, followersOnly, open]);
    expect(await uris(actor, "", "profile-private-mentioned@example.com")).toEqual([
      reply,
      direct,
      open,
    ]);
    expect(await uris(actor, "?exclude_replies=true", follower)).toEqual([followersOnly, open]);
  });

  it("is empty for a viewer who blocks the actor and 404 for an unknown one", async () => {
    const actor = await remoteActor("profile-blocked-actor", "blocked-profile.example");
    const email = "profile-blocking-viewer@example.com";
    await note(actor, "profile-blocked-note");
    expect(await uris(actor, "", email)).toHaveLength(1);

    const blocked = await json(`/api/v1/accounts/${accountId(actor)}/block`, {
      method: "POST",
      headers: await authHeaders(email),
    });
    expect(blocked.status).toBe(200);
    expect(await uris(actor, "", email)).toEqual([]);
    expect(await uris(actor)).toHaveLength(1);

    const unknown = RemoteAccountId.encode("https://nowhere.example/users/nobody");
    expect((await json(`/api/v1/accounts/${unknown}/statuses`)).status).toBe(404);
  });
});
