import { schemaResult } from "@tstodon/core";
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const get = async <T>(email: string, path: string, schema: z.ZodType<T>): Promise<T> =>
  read(schema, (await json(path, { headers: await authHeaders(email) })).body);

const me = (email: string) =>
  get(
    email,
    "/api/v1/accounts/verify_credentials",
    z.object({ id: z.string(), username: z.string() }),
  );

const post = async (email: string, status: string) =>
  read(
    z.object({ id: z.string(), uri: z.string() }),
    (
      await json("/api/v1/statuses", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await authHeaders(email)) },
        body: JSON.stringify({ status }),
      })
    ).body,
  );

const act = async (email: string, path: string) =>
  (await json(path, { method: "POST", headers: await authHeaders(email) })).status;

/** What every notification surface reports for `email`. */
const surfaces = async (email: string) => ({
  list: (await get(email, "/api/v1/notifications", z.array(z.object({ type: z.string() })))).map(
    (entry) => entry.type,
  ),
  groups: (
    await get(
      email,
      "/api/v2/notifications",
      z.object({ notification_groups: z.array(z.object({ type: z.string() })) }),
    )
  ).notification_groups.map((group) => group.type),
  unread: (await get(email, "/api/v1/notifications/unread_count", z.object({ count: z.number() })))
    .count,
});

describe("muted conversations", () => {
  it("drops notifications for remote replies anywhere under a muted thread", async () => {
    const email = "mute-remote-author@example.com";
    const author = await me(email);
    const authorUrl = `https://example.com/users/${author.username}`;
    const remote = await remoteActor("mute-replier");
    const reply = (n: number, inReplyTo: string) => ({
      id: `https://remote.example/activities/mute-reply-${n}`,
      type: "Create",
      object: {
        id: `https://remote.example/notes/mute-reply-${n}`,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>reply ${n}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        inReplyTo,
        to: ["https://www.w3.org/ns/activitystreams#Public"],
        cc: [authorUrl],
        tag: [{ type: "Mention", href: authorUrl, name: `@${author.username}@example.com` }],
      },
    });

    const muted = await post(email, "a thread I will mute");
    expect(await act(email, `/api/v1/statuses/${muted.id}/mute`)).toBe(200);
    // A direct reply, and a reply to that reply (two hops from the local root).
    expect(await remote.send(reply(1, muted.uri))).toBe(202);
    expect(await remote.send(reply(2, "https://remote.example/notes/mute-reply-1"))).toBe(202);
    expect(await surfaces(email)).toEqual({ list: [], groups: [], unread: 0 });

    // The same reply into a thread that is not muted does notify.
    const open = await post(email, "a thread I keep");
    expect(await remote.send(reply(3, open.uri))).toBe(202);
    expect(await surfaces(email)).toEqual({ list: ["mention"], groups: ["mention"], unread: 1 });
  });

  it("keeps local interactions with a muted thread out of every surface", async () => {
    const email = "mute-local-author@example.com";
    const muted = await post(email, "muted for favourites");
    expect(await act(email, `/api/v1/statuses/${muted.id}/mute`)).toBe(200);
    expect(await act("mute-local-fan@example.com", `/api/v1/statuses/${muted.id}/favourite`)).toBe(
      200,
    );
    // Before, the v1 list hid it but the grouped list and unread count showed it.
    expect(await surfaces(email)).toEqual({ list: [], groups: [], unread: 0 });
  });

  it("hides remote direct replies into a muted thread from the direct timeline", async () => {
    const email = "mute-direct-author@example.com";
    const author = await me(email);
    const authorUrl = `https://example.com/users/${author.username}`;
    const remote = await remoteActor("mute-direct-replier");
    const direct = (n: number, inReplyTo: string) => ({
      id: `https://remote.example/activities/mute-direct-${n}`,
      type: "Create",
      object: {
        id: `https://remote.example/notes/mute-direct-${n}`,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>direct ${n}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        inReplyTo,
        to: [authorUrl],
        tag: [{ type: "Mention", href: authorUrl, name: `@${author.username}@example.com` }],
      },
    });
    const muted = await post(email, "muted thread");
    const open = await post(email, "open thread");
    expect(await act(email, `/api/v1/statuses/${muted.id}/mute`)).toBe(200);
    expect(await remote.send(direct(1, muted.uri))).toBe(202);
    expect(await remote.send(direct(2, open.uri))).toBe(202);

    const timeline = await get(
      email,
      "/api/v1/timelines/direct",
      z.array(z.object({ uri: z.string() })),
    );
    expect(timeline.map((status) => status.uri)).toEqual([
      "https://remote.example/notes/mute-direct-2",
    ]);
  });
});
