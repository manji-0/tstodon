import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { acceptPrivateMentions } from "../test/notification-policy-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { RemoteAccountId } from "./remote-account-id";

// Mastodon's `limited`: a note its audience makes direct, which reaches an
// account Mastodon knows other than through a `Mention` tag
// (`Create#process_audience`, `postprocess_audience_and_deliver`).

const HOST = "limited.example";

const request = async (email: string | undefined, path: string, init: RequestInit = {}) =>
  SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(email === undefined ? {} : await authHeaders(email)),
    },
  });

const call = async (email: string, path: string, init: RequestInit = {}): Promise<unknown> => {
  const response = await request(email, path, init);
  expect(response.status, path).toBe(200);
  return response.json();
};

const actorUrl = (username: string) => `https://example.com/users/${username}`;

/** Send a note `remote` wrote in a `Create`, to the shared inbox or to `inbox`'s own. */
const sendNote = async (
  remote: Remote,
  slug: string,
  note: Readonly<{ to: string[]; cc?: string[]; tag?: string[]; inbox?: string }>,
): Promise<string> => {
  const objectUri = `https://${HOST}/notes/${slug}`;
  const activity = {
    id: `${objectUri}/create`,
    type: "Create",
    object: {
      id: objectUri,
      type: "Note",
      attributedTo: remote.actorUri,
      content: `<p>${slug}</p>`,
      published: new Date().toISOString(),
      to: note.to,
      cc: note.cc ?? [],
      tag: (note.tag ?? []).map((href) => ({ type: "Mention", href })),
    },
  };
  expect(
    note.inbox === undefined
      ? await remote.send(activity)
      : await remote.sendTo(note.inbox, activity),
  ).toBe(202);
  return objectUri;
};

const stored = async (objectUri: string) => {
  const [row] = parseRows(
    z.object({ id: z.string(), visibility: z.string() }),
    (
      await env.DB.prepare("SELECT id, visibility FROM remote_statuses WHERE object_uri = ?")
        .bind(objectUri)
        .all()
    ).results,
  );
  if (!row) {
    throw new Error(`remote note ${objectUri} was not stored`);
  }
  return row;
};

const statusAs = async (email: string | undefined, id: string) => {
  const response = await request(email, `/api/v1/statuses/${id}`);
  return response.status === 200
    ? { status: 200, body: expectContract(ApiStatus, await response.json()) }
    : { status: response.status, body: undefined };
};

const idsIn = async (email: string, path: string): Promise<string[]> =>
  z
    .array(z.object({ id: z.string() }))
    .parse(await call(email, path))
    .map((entry) => entry.id);

const conversationStatusIds = async (email: string): Promise<string[]> =>
  z
    .array(z.object({ last_status: z.object({ id: z.string() }).nullable() }))
    .parse(await call(email, "/api/v1/conversations"))
    .flatMap((conversation) => (conversation.last_status ? [conversation.last_status.id] : []));

const mentionNotified = async (email: string, statusId: string): Promise<boolean> =>
  z
    .array(z.object({ type: z.string(), status: z.object({ id: z.string() }).nullish() }))
    .parse(await call(email, "/api/v1/notifications?types[]=mention"))
    .some((entry) => entry.status?.id === statusId);

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

describe("a remote direct note with an audience-only account", () => {
  it("is stored limited, served as private, and shown to the accounts it reaches only", async () => {
    const mentioned = await signedInAccount("lim-mentioned@example.com");
    const addressed = await signedInAccount("lim-addressed@example.com");
    const author = await remoteActor("limauthor", HOST);
    const objectUri = await sendNote(author, "lim-basic", {
      to: [actorUrl(mentioned.username)],
      cc: [actorUrl(addressed.username)],
      tag: [actorUrl(mentioned.username)],
    });
    const row = await stored(objectUri);
    expect(row.visibility).toBe("limited");
    for (const email of ["lim-mentioned@example.com", "lim-addressed@example.com"]) {
      const seen = await statusAs(email, row.id);
      expect(seen.status, email).toBe(200);
      expect(seen.body?.visibility, email).toBe("private");
      expect(seen.body?.mentions.map((mention) => mention.username)).toEqual([mentioned.username]);
    }
    expect((await statusAs("lim-stranger@example.com", row.id)).status).toBe(404);
    expect((await statusAs(undefined, row.id)).status).toBe(404);
  });

  it("stays direct when its audience names only the accounts it tags", async () => {
    const mentioned = await signedInAccount("lim-direct-only@example.com");
    const author = await remoteActor("limdirect", HOST);
    const objectUri = await sendNote(author, "lim-direct", {
      to: [actorUrl(mentioned.username)],
      tag: [actorUrl(mentioned.username)],
    });
    const row = await stored(objectUri);
    expect(row.visibility).toBe("direct");
    expect((await statusAs("lim-direct-only@example.com", row.id)).body?.visibility).toBe("direct");
  });

  it("is limited when a cached remote actor is in its audience without a tag", async () => {
    const mentioned = await signedInAccount("lim-remote-cc@example.com");
    const author = await remoteActor("limremotecc", HOST);
    const other = await remoteActor("limknown", "elsewhere.example");
    const objectUri = await sendNote(author, "lim-remote-cc", {
      to: [actorUrl(mentioned.username)],
      cc: [other.actorUri],
      tag: [actorUrl(mentioned.username)],
    });
    expect((await stored(objectUri)).visibility).toBe("limited");
  });

  it("is limited when it comes to the personal inbox of an account it does not mention", async () => {
    const mentioned = await signedInAccount("lim-inbox-mentioned@example.com");
    const owner = await signedInAccount("lim-inbox-owner@example.com");
    const author = await remoteActor("liminbox", HOST);
    const objectUri = await sendNote(author, "lim-inbox", {
      to: [actorUrl(mentioned.username)],
      tag: [actorUrl(mentioned.username)],
      inbox: owner.username,
    });
    const row = await stored(objectUri);
    expect(row.visibility).toBe("limited");
    const seen = await statusAs("lim-inbox-owner@example.com", row.id);
    expect(seen.status).toBe(200);
    expect(seen.body?.mentions.map((mention) => mention.username)).toEqual([mentioned.username]);
    expect(await mentionNotified("lim-inbox-owner@example.com", row.id)).toBe(false);
  });

  it("stays direct when it comes to the personal inbox of an account it mentions", async () => {
    const mentioned = await signedInAccount("lim-inbox-tagged@example.com");
    const author = await remoteActor("liminboxtagged", HOST);
    const objectUri = await sendNote(author, "lim-inbox-tagged", {
      to: [actorUrl(mentioned.username)],
      tag: [actorUrl(mentioned.username)],
      inbox: mentioned.username,
    });
    expect((await stored(objectUri)).visibility).toBe("direct");
  });

  it("joins no conversation and no direct timeline", async () => {
    const email = "lim-conversation@example.com";
    const mentioned = await signedInAccount(email);
    await acceptPrivateMentions(email);
    const addressed = await signedInAccount("lim-conversation-cc@example.com");
    await acceptPrivateMentions("lim-conversation-cc@example.com");
    const author = await remoteActor("limconversation", HOST);
    const limited = await stored(
      await sendNote(author, "lim-conversation", {
        to: [actorUrl(mentioned.username), actorUrl(addressed.username)],
        tag: [actorUrl(mentioned.username)],
      }),
    );
    const direct = await stored(
      await sendNote(author, "lim-conversation-direct", {
        to: [actorUrl(mentioned.username)],
        tag: [actorUrl(mentioned.username)],
      }),
    );
    expect(limited.visibility).toBe("limited");
    expect(await conversationStatusIds(email)).toEqual([direct.id]);
    expect(await idsIn(email, "/api/v1/timelines/direct")).toEqual([direct.id]);
    expect(await conversationStatusIds("lim-conversation-cc@example.com")).toEqual([]);
  });

  it("notifies the account it mentions past the private-mention policy", async () => {
    // Mastodon's `private_mention_not_in_response?` asks for a direct status only.
    const email = "lim-policy@example.com";
    const mentioned = await signedInAccount(email);
    const addressed = await signedInAccount("lim-policy-cc@example.com");
    const author = await remoteActor("limpolicy", HOST);
    const limited = await stored(
      await sendNote(author, "lim-policy", {
        to: [actorUrl(mentioned.username)],
        cc: [actorUrl(addressed.username)],
        tag: [actorUrl(mentioned.username)],
      }),
    );
    const direct = await stored(
      await sendNote(author, "lim-policy-direct", {
        to: [actorUrl(mentioned.username)],
        tag: [actorUrl(mentioned.username)],
      }),
    );
    expect(await mentionNotified(email, limited.id)).toBe(true);
    expect(await mentionNotified(email, direct.id)).toBe(false);
    expect(await mentionNotified("lim-policy-cc@example.com", limited.id)).toBe(false);
  });

  it("reaches the home of a follower it addresses, and no other follower's home or list", async () => {
    const addressedEmail = "lim-home-addressed@example.com";
    const otherEmail = "lim-home-other@example.com";
    const addressed = await signedInAccount(addressedEmail);
    const mentioned = await signedInAccount("lim-home-mentioned@example.com");
    await signedInAccount(otherEmail);
    const author = await remoteActor("limhome", HOST);
    await followRemote(addressedEmail, author);
    await followRemote(otherEmail, author);
    const list = z.object({ id: z.string() }).parse(
      await call(addressedEmail, "/api/v1/lists", {
        method: "POST",
        body: JSON.stringify({ title: "limited" }),
      }),
    );
    await call(addressedEmail, `/api/v1/lists/${list.id}/accounts`, {
      method: "POST",
      body: JSON.stringify({ account_ids: [RemoteAccountId.encode(author.actorUri)] }),
    });
    const limited = await stored(
      await sendNote(author, "lim-home", {
        to: [actorUrl(mentioned.username), actorUrl(addressed.username)],
        tag: [actorUrl(mentioned.username)],
      }),
    );
    expect(limited.visibility).toBe("limited");
    expect(await idsIn(addressedEmail, "/api/v1/timelines/home")).toContain(limited.id);
    expect(await idsIn(otherEmail, "/api/v1/timelines/home")).not.toContain(limited.id);
    expect(await idsIn(addressedEmail, `/api/v1/timelines/list/${list.id}`)).not.toContain(
      limited.id,
    );
  });

  it("cannot be boosted by an account it reaches", async () => {
    // `StatusPolicy#reblog?` refuses a status that `requires_mention?`.
    const email = "lim-boost@example.com";
    const mentioned = await signedInAccount(email);
    const addressed = await signedInAccount("lim-boost-cc@example.com");
    const author = await remoteActor("limboost", HOST);
    const limited = await stored(
      await sendNote(author, "lim-boost", {
        to: [actorUrl(mentioned.username)],
        cc: [actorUrl(addressed.username)],
        tag: [actorUrl(mentioned.username)],
      }),
    );
    expect(
      (
        await request(email, `/api/v1/statuses/${limited.id}/reblog`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });

  it("stays limited after an Update", async () => {
    const mentioned = await signedInAccount("lim-update@example.com");
    const addressed = await signedInAccount("lim-update-cc@example.com");
    const author = await remoteActor("limupdate", HOST);
    const objectUri = await sendNote(author, "lim-update", {
      to: [actorUrl(mentioned.username)],
      cc: [actorUrl(addressed.username)],
      tag: [actorUrl(mentioned.username)],
    });
    expect(
      await author.send({
        id: `${objectUri}/update`,
        type: "Update",
        object: {
          id: objectUri,
          type: "Note",
          attributedTo: author.actorUri,
          content: "<p>edited</p>",
          published: new Date(Date.now() - 1000).toISOString(),
          updated: new Date().toISOString(),
          to: [actorUrl(mentioned.username)],
          tag: [{ type: "Mention", href: actorUrl(mentioned.username) }],
        },
      }),
    ).toBe(202);
    const row = await stored(objectUri);
    expect(row.visibility).toBe("limited");
    expect((await statusAs("lim-update-cc@example.com", row.id)).status).toBe(200);
  });
});
