import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiStatus } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { acceptPrivateMentions } from "../test/notification-policy-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { parseRows } from "./d1";
import { unsignedFetch } from "./federated-fetch";
import { RemoteAccountId } from "./remote-account-id";
import { storeNoteDocument } from "./remote-status-persist";
import { parseInstanceIdentity } from "./runtime-config";

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

type NoteAudience = Readonly<{ to: string[]; cc?: string[]; tag?: string[] }>;

const noteUri = (slug: string) => `https://${HOST}/notes/${slug}`;

/** The note `author` wrote as `slug`, addressed to `note`. */
const noteDocument = (author: string, slug: string, note: NoteAudience) => ({
  id: noteUri(slug),
  type: "Note",
  attributedTo: author,
  content: `<p>${slug}</p>`,
  published: new Date().toISOString(),
  to: note.to,
  cc: note.cc ?? [],
  tag: (note.tag ?? []).map((href) => ({ type: "Mention", href })),
});

/** The `Create` of {@link noteDocument}, sent by `sender`: the same activity id each time. */
const noteCreate = (sender: Remote, author: string, slug: string, note: NoteAudience) => ({
  id: `${noteUri(slug)}/create`,
  type: "Create",
  actor: sender.actorUri,
  object: noteDocument(author, slug, note),
});

/** Send a note `remote` wrote in a `Create`, to the shared inbox or to `inbox`'s own. */
const sendNote = async (
  remote: Remote,
  slug: string,
  note: NoteAudience & Readonly<{ inbox?: string }>,
): Promise<string> => {
  const activity = noteCreate(remote, remote.actorUri, slug, note);
  expect(
    note.inbox === undefined
      ? await remote.send(activity)
      : await remote.sendTo(note.inbox, activity),
  ).toBe(202);
  return noteUri(slug);
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
const followRemote = async (
  email: string,
  remote: Remote,
  options: Readonly<{ notify?: boolean }> = {},
): Promise<void> => {
  await call(email, `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`, {
    method: "POST",
    body: JSON.stringify(options),
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

  it("stays direct when its tag names an account by its profile URL", async () => {
    // Mastodon's `uris_to_local_accounts` reads `/@name` as the account, as `/users/name`.
    const email = "lim-profile-url@example.com";
    const mentioned = await signedInAccount(email);
    const author = await remoteActor("limprofileurl", HOST);
    const objectUri = await sendNote(author, "lim-profile-url", {
      to: [actorUrl(mentioned.username)],
      tag: [`https://example.com/@${mentioned.username}`],
    });
    const row = await stored(objectUri);
    expect(row.visibility).toBe("direct");
    const seen = await statusAs(email, row.id);
    expect(seen.body?.mentions.map((mention) => mention.username)).toEqual([mentioned.username]);
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

  it("keeps the visibility it was stored with when its document is stored again", async () => {
    // Mastodon sets a status's visibility once, in `Create#process_status`.
    const mentioned = await signedInAccount("lim-restore@example.com");
    const addressed = await signedInAccount("lim-restore-cc@example.com");
    const author = await remoteActor("limrestore", HOST);
    const objectUri = await sendNote(author, "lim-restore", {
      to: [actorUrl(mentioned.username)],
      tag: [actorUrl(mentioned.username)],
    });
    expect((await stored(objectUri)).visibility).toBe("direct");
    const restored = await storeNoteDocument(
      env,
      parseInstanceIdentity(env)._unsafeUnwrap(),
      objectUri,
      {
        id: objectUri,
        type: "Note",
        attributedTo: author.actorUri,
        content: "<p>lim-restore</p>",
        published: new Date().toISOString(),
        to: [actorUrl(mentioned.username), actorUrl(addressed.username)],
        tag: [{ type: "Mention", href: actorUrl(mentioned.username) }],
      },
      { fetchSigner: unsignedFetch },
    );
    expect(restored.isOk()).toBe(true);
    expect((await stored(objectUri)).visibility).toBe("direct");
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

describe("a Create of a note already held, delivered to a personal inbox", () => {
  // `Create#create_status` runs `postprocess_audience_and_deliver` on each
  // delivery to a personal inbox (`delivered_to_account_id`) of a status it
  // holds: Mastodon skips no repeated activity id.
  const notified = async (email: string, type: string, statusId: string): Promise<boolean> =>
    z
      .array(z.object({ type: z.string(), status: z.object({ id: z.string() }).nullish() }))
      .parse(await call(email, `/api/v1/notifications?types[]=${type}`))
      .some((entry) => entry.type === type && entry.status?.id === statusId);

  const mentioning = (username: string): NoteAudience => ({
    to: [actorUrl(username)],
    tag: [actorUrl(username)],
  });

  it("gives the inbox's owner a silent mention and makes a direct note limited", async () => {
    const mentioned = await signedInAccount("held-shared-mentioned@example.com");
    const owner = await signedInAccount("held-shared-owner@example.com");
    const author = await remoteActor("heldshared", HOST);
    const create = noteCreate(
      author,
      author.actorUri,
      "held-shared",
      mentioning(mentioned.username),
    );
    expect(await author.send(create)).toBe(202);
    const before = await stored(noteUri("held-shared"));
    expect(before.visibility).toBe("direct");
    expect((await statusAs("held-shared-owner@example.com", before.id)).status).toBe(404);

    expect(await author.sendTo(owner.username, create)).toBe(202);
    const after = await stored(noteUri("held-shared"));
    expect(after.visibility).toBe("limited");
    const seen = await statusAs("held-shared-owner@example.com", after.id);
    expect(seen.status).toBe(200);
    expect(seen.body?.visibility).toBe("private");
    expect(seen.body?.mentions.map((mention) => mention.username)).toEqual([mentioned.username]);
    expect(await mentionNotified("held-shared-owner@example.com", after.id)).toBe(false);
  });

  it("reaches the owner of a second personal inbox the same activity comes to", async () => {
    const mentioned = await signedInAccount("held-second-mentioned@example.com");
    const owner = await signedInAccount("held-second-owner@example.com");
    const author = await remoteActor("heldsecond", HOST);
    const create = noteCreate(
      author,
      author.actorUri,
      "held-second",
      mentioning(mentioned.username),
    );
    expect(await author.sendTo(mentioned.username, create)).toBe(202);
    expect((await stored(noteUri("held-second"))).visibility).toBe("direct");

    expect(await author.sendTo(owner.username, create)).toBe(202);
    const row = await stored(noteUri("held-second"));
    expect(row.visibility).toBe("limited");
    expect((await statusAs("held-second-owner@example.com", row.id)).status).toBe(200);
  });

  it("answers its redelivery to the same personal inbox as a duplicate", async () => {
    const email = "held-redelivered@example.com";
    const mentioned = await signedInAccount("held-redelivered-mentioned@example.com");
    const owner = await signedInAccount(email);
    const author = await remoteActor("heldredelivered", HOST);
    const create = noteCreate(
      author,
      author.actorUri,
      "held-redelivered",
      mentioning(mentioned.username),
    );
    expect(await author.send(create)).toBe(202);
    expect(await author.sendTo(owner.username, create)).toBe(202);
    const row = await stored(noteUri("held-redelivered"));
    expect((await statusAs(email, row.id)).status).toBe(200);
    await env.DB.prepare(
      "DELETE FROM remote_status_mentions WHERE status_id = ? AND account_id = ?",
    )
      .bind(row.id, owner.id)
      .run();

    expect(await author.sendTo(owner.username, create)).toBe(202);
    expect((await statusAs(email, row.id)).status).toBe(404);
  });

  it("changes nothing when the inbox's owner is mentioned already", async () => {
    const mentioned = await signedInAccount("held-tagged@example.com");
    const author = await remoteActor("heldtagged", HOST);
    const create = noteCreate(
      author,
      author.actorUri,
      "held-tagged",
      mentioning(mentioned.username),
    );
    expect(await author.send(create)).toBe(202);
    expect(await author.sendTo(mentioned.username, create)).toBe(202);
    const row = await stored(noteUri("held-tagged"));
    expect(row.visibility).toBe("direct");
    expect((await statusAs("held-tagged@example.com", row.id)).body?.visibility).toBe("direct");
  });

  it("reaches a note this server fetched before it was delivered", async () => {
    const mentioned = await signedInAccount("held-fetched-mentioned@example.com");
    const owner = await signedInAccount("held-fetched-owner@example.com");
    const author = await remoteActor("heldfetched", HOST);
    const audience = mentioning(mentioned.username);
    const fetched = await storeNoteDocument(
      env,
      parseInstanceIdentity(env)._unsafeUnwrap(),
      noteUri("held-fetched"),
      noteDocument(author.actorUri, "held-fetched", audience),
      { fetchSigner: unsignedFetch },
    );
    expect(fetched.isOk()).toBe(true);
    expect((await stored(noteUri("held-fetched"))).visibility).toBe("direct");

    const create = noteCreate(author, author.actorUri, "held-fetched", audience);
    expect(await author.sendTo(owner.username, create)).toBe(202);
    const row = await stored(noteUri("held-fetched"));
    expect(row.visibility).toBe("limited");
    expect((await statusAs("held-fetched-owner@example.com", row.id)).status).toBe(200);
  });

  it("reaches the home of an owner following the author, with the status notification its follow asks for", async () => {
    // `postprocess_audience_and_deliver` queues `FeedInsertWorker`, whose
    // `notify?` sends a follow's `status` notification.
    const email = "held-follower@example.com";
    const mentioned = await signedInAccount("held-follower-mentioned@example.com");
    const owner = await signedInAccount(email);
    const author = await remoteActor("heldfollower", HOST);
    await followRemote(email, author, { notify: true });
    const create = noteCreate(
      author,
      author.actorUri,
      "held-follower",
      mentioning(mentioned.username),
    );
    expect(await author.send(create)).toBe(202);
    const row = await stored(noteUri("held-follower"));
    expect(await idsIn(email, "/api/v1/timelines/home")).not.toContain(row.id);
    expect(await notified(email, "status", row.id)).toBe(false);

    expect(await author.sendTo(owner.username, create)).toBe(202);
    expect(await idsIn(email, "/api/v1/timelines/home")).toContain(row.id);
    expect(await notified(email, "status", row.id)).toBe(true);
    expect(await notified(email, "mention", row.id)).toBe(false);
  });

  it("sends no status notification to an owner who does not follow the author", async () => {
    const email = "held-stranger@example.com";
    const owner = await signedInAccount(email);
    const author = await remoteActor("heldstranger", HOST);
    const create = noteCreate(author, author.actorUri, "held-stranger", {
      to: ["https://www.w3.org/ns/activitystreams#Public"],
    });
    expect(await author.send(create)).toBe(202);
    expect(await author.sendTo(owner.username, create)).toBe(202);
    const row = await stored(noteUri("held-stranger"));
    expect(row.visibility).toBe("public");
    expect(await notified(email, "status", row.id)).toBe(false);
  });

  it("is ignored from an actor that did not write the note", async () => {
    // `create_status` rejects a `Create` whose actor is not the status's author.
    const mentioned = await signedInAccount("held-impostor-mentioned@example.com");
    const owner = await signedInAccount("held-impostor-owner@example.com");
    const author = await remoteActor("heldauthor", HOST);
    const impostor = await remoteActor("heldimpostor", HOST);
    const audience = mentioning(mentioned.username);
    expect(await author.send(noteCreate(author, author.actorUri, "held-impostor", audience))).toBe(
      202,
    );
    expect(
      await impostor.sendTo(
        owner.username,
        noteCreate(impostor, author.actorUri, "held-impostor", audience),
      ),
    ).toBe(202);
    const row = await stored(noteUri("held-impostor"));
    expect(row.visibility).toBe("direct");
    expect((await statusAs("held-impostor-owner@example.com", row.id)).status).toBe(404);
  });
});
