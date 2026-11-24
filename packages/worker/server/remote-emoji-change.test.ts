import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { CoveredHosts } from "@tstodon/domain";
import migration from "../app/db/migrations/0180_remote_custom_emoji_render.sql?raw";
import { adminBrowser } from "../test/admin-browser";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { settle } from "../test/meter";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { webfingerAnswer } from "../test/webfinger-fixture";
import { unsignedFetch } from "./federated-fetch";
import { RemoteAccountId } from "./remote-account-id";
import { refreshRemoteActor } from "./remote-actor-fetch";
import { parseInstanceIdentity } from "./runtime-config";

// Mastodon v4.7.5 renders a remote post, version, poll or profile with
// `CustomEmoji.from_text(text, account.domain)`, read at each render: each
// `:shortcode:` it writes shows the domain's one enabled emoji of that name,
// its current image, whenever the emoji was learned.

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const Emojis = z.array(
  z.object({ shortcode: z.string(), url: z.string(), static_url: z.string() }),
);

/** The image each custom emoji shows, by shortcode. */
const byShortcode = (emojis: z.infer<typeof Emojis>): Record<string, string> =>
  Object.fromEntries(
    emojis.map((emoji) => {
      expect(emoji.static_url).toBe(emoji.url);
      return [emoji.shortcode, emoji.url];
    }),
  );

const get = async (path: string, headers: Record<string, string> = {}): Promise<unknown> => {
  const response = await SELF.fetch(`https://example.com${path}`, { headers });
  expect(response.status, path).toBe(200);
  return response.json();
};

const statusEmojis = async (id: string): Promise<Record<string, string>> =>
  byShortcode(read(z.object({ emojis: Emojis }), await get(`/api/v1/statuses/${id}`)).emojis);

const accountEmojis = async (actorUri: string): Promise<Record<string, string>> =>
  byShortcode(
    read(
      z.object({ emojis: Emojis }),
      await get(`/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`),
    ).emojis,
  );

const historyEmojis = async (id: string): Promise<Array<Record<string, string>>> =>
  read(z.array(z.object({ emojis: Emojis })), await get(`/api/v1/statuses/${id}/history`)).map(
    (version) => byShortcode(version.emojis),
  );

/** A poll's emoji, as its status embeds it and as `GET /api/v1/polls/:id` answers it. */
const pollEmojis = async (id: string): Promise<Record<string, string>> => {
  const status = read(
    z.object({ poll: z.object({ id: z.string(), emojis: Emojis }) }),
    await get(`/api/v1/statuses/${id}`),
  );
  const poll = read(z.object({ emojis: Emojis }), await get(`/api/v1/polls/${status.poll.id}`));
  expect(byShortcode(poll.emojis)).toEqual(byShortcode(status.poll.emojis));
  return byShortcode(poll.emojis);
};

/** An `Emoji` tag; Mastodon dates each with the emoji's `updated_at`. */
const emojiTag = (shortcode: string, url: string, updated?: string) => ({
  type: "Emoji",
  name: `:${shortcode}:`,
  icon: { type: "Image", mediaType: "image/png", url },
  ...(updated === undefined ? {} : { updated }),
});

const noteOf = (
  author: Remote,
  slug: string,
  content: string,
  tag: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) => ({
  id: `${new URL(author.actorUri).origin}/notes/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content,
  published: "2026-11-20T00:00:00.000Z",
  to: [PUBLIC],
  tag,
  ...extra,
});

const storedId = async (objectUri: string): Promise<string> =>
  read(
    z.object({ id: z.string() }),
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(objectUri)
      .first(),
  ).id;

/** `author` sends `object` in a `Create`; the id it is stored under here. */
const create = async (author: Remote, object: Record<string, unknown> & { id: string }) => {
  expect(await author.send({ id: `${object.id}/activity`, type: "Create", object })).toBe(202);
  return storedId(object.id);
};

/** `author` posts a public note; the id it is stored under here. */
const post = (
  author: Remote,
  slug: string,
  content: string,
  tag: ReadonlyArray<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Promise<string> => create(author, noteOf(author, slug, content, tag, extra));

/** `author` posts a poll whose options are `options`. */
const postPoll = (
  author: Remote,
  slug: string,
  options: ReadonlyArray<string>,
  tag: ReadonlyArray<Record<string, unknown>> = [],
): Promise<string> =>
  post(author, slug, "<p>vote</p>", tag, {
    type: "Question",
    endTime: "2099-01-01T00:00:00.000Z",
    oneOf: options.map((name) => ({
      type: "Note",
      name,
      replies: { type: "Collection", totalItems: 0 },
    })),
  });

const updateProfile = async (actor: Remote, name: string, tag: ReadonlyArray<unknown>) => {
  expect(
    await actor.send({
      id: `${actor.actorUri}#updates/${crypto.randomUUID()}`,
      type: "Update",
      object: {
        id: actor.actorUri,
        type: "Person",
        preferredUsername: actor.actorUri.split("/").pop(),
        name,
        inbox: `${actor.actorUri}/inbox`,
        publicKey: {
          id: `${actor.actorUri}#main-key`,
          owner: actor.actorUri,
          publicKeyPem: actor.publicKeyPem,
        },
        tag,
      },
    }),
  ).toBe(202);
};

describe("a remote custom emoji whose image changes", () => {
  it("shows the new image on every post and profile of its server, as Mastodon's one emoji per server", async () => {
    const host = "emoji-change.example";
    const old = `https://${host}/system/blob-1.png`;
    const changed = `https://${host}/system/blob-2.png`;
    const other = `https://${host}/system/other.png`;
    const alice = await remoteActor("alice", host);
    const bob = await remoteActor("bob", host);
    const elsewhere = await remoteActor("carol", "emoji-elsewhere.example");

    const first = await post(alice, "first", "<p>:blob: :other:</p>", [
      emojiTag("blob", old),
      emojiTag("other", other),
    ]);
    const bobs = await post(bob, "bobs", "<p>:blob:</p>", [emojiTag("blob", old)]);
    const carols = await post(elsewhere, "carols", "<p>:blob:</p>", [emojiTag("blob", old)]);
    await updateProfile(bob, "Bob :blob:", [emojiTag("blob", old)]);
    expect(await accountEmojis(bob.actorUri)).toEqual({ blob: old });

    const second = await post(alice, "second", "<p>:blob: again</p>", [emojiTag("blob", changed)]);

    expect(await statusEmojis(second)).toEqual({ blob: changed });
    expect(await statusEmojis(first)).toEqual({ blob: changed, other });
    expect(await statusEmojis(bobs)).toEqual({ blob: changed });
    expect(await accountEmojis(bob.actorUri)).toEqual({ blob: changed });
    // Another server's emoji of the same name is its own.
    expect(await statusEmojis(carols)).toEqual({ blob: old });
  });

  it("shows the new image in an edited post's earlier versions", async () => {
    const host = "emoji-change-history.example";
    const old = `https://${host}/system/wave-1.png`;
    const changed = `https://${host}/system/wave-2.png`;
    const author = await remoteActor("dave", host);
    const id = await post(author, "edited", "<p>:wave:</p>", [emojiTag("wave", old)]);
    const object = noteOf(author, "edited", "<p>:wave: edited</p>", [emojiTag("wave", old)], {
      updated: "2026-11-21T00:00:00.000Z",
    });
    expect(await author.send({ id: `${object.id}/update`, type: "Update", object })).toBe(202);
    expect(await historyEmojis(id)).toEqual([{ wave: old }, { wave: old }]);

    await post(author, "later", "<p>:wave:</p>", [emojiTag("wave", changed)]);

    expect(await historyEmojis(id)).toEqual([{ wave: changed }, { wave: changed }]);
  });

  it("shows an image a profile update changes on the server's posts", async () => {
    const host = "emoji-change-profile.example";
    const old = `https://${host}/system/cat-1.png`;
    const changed = `https://${host}/system/cat-2.png`;
    const author = await remoteActor("frank", host);
    const id = await post(author, "cat", "<p>:cat:</p>", [emojiTag("cat", old)]);

    await updateProfile(author, "Frank :cat:", [emojiTag("cat", changed)]);

    expect(await accountEmojis(author.actorUri)).toEqual({ cat: changed });
    expect(await statusEmojis(id)).toEqual({ cat: changed });
  });

  // Mastodon keeps its stored image when the one a late delivery names does
  // not download, and the server has deleted the replaced file.
  it("keeps the newer image when a delivery dated before it comes later", async () => {
    const host = "emoji-change-late.example";
    const old = `https://${host}/system/late-1.png`;
    const changed = `https://${host}/system/late-2.png`;
    const author = await remoteActor("hana", host);
    const first = await post(author, "first", "<p>:late:</p>", [
      emojiTag("late", old, "2026-11-01T00:00:00Z"),
    ]);
    const second = await post(author, "second", "<p>:late:</p>", [
      emojiTag("late", changed, "2026-11-10T00:00:00Z"),
    ]);

    const retried = await post(author, "retried", "<p>:late:</p>", [
      emojiTag("late", old, "2026-11-01T00:00:00Z"),
    ]);

    expect(await statusEmojis(first)).toEqual({ late: changed });
    expect(await statusEmojis(second)).toEqual({ late: changed });
    expect(await statusEmojis(retried)).toEqual({ late: changed });
  });

  // `ProcessAccountService#process_emojis` runs on every fetch of an
  // account, and the new image shows on the server's posts at once.
  it("shows an image a fetched actor document changes on the server's posts", async () => {
    const host = "emoji-change-fetched.example";
    const old = `https://${host}/system/owl-1.png`;
    const changed = `https://${host}/system/owl-2.png`;
    const author = await remoteActor("oscar", host);
    const id = await post(author, "owl", "<p>:owl:</p>", [emojiTag("owl", old)]);
    const document = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: author.actorUri,
      type: "Person",
      preferredUsername: "oscar",
      name: "Oscar :owl:",
      inbox: `${author.actorUri}/inbox`,
      publicKey: {
        id: `${author.actorUri}#main-key`,
        owner: author.actorUri,
        publicKeyPem: author.publicKeyPem,
      },
      tag: [emojiTag("owl", changed)],
    };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/.well-known/webfinger") {
        return webfingerAnswer({ [author.actorUri]: document }, url);
      }
      return url.href === author.actorUri
        ? Response.json(document, { headers: { "content-type": "application/activity+json" } })
        : new Response(null, { status: 404 });
    });
    try {
      const identity = parseInstanceIdentity(env);
      if (identity.isErr()) {
        throw new Error("no instance identity");
      }
      const refreshed = await refreshRemoteActor(env.DB, identity.value, author.actorUri, {
        allowHosts: new Set<string>(),
        blockedHosts: CoveredHosts.none,
        fetchSigner: unsignedFetch,
      });
      expect(refreshed.isOk()).toBe(true);
    } finally {
      fetch.mockRestore();
    }

    expect(await accountEmojis(author.actorUri)).toEqual({ owl: changed });
    expect(await statusEmojis(id)).toEqual({ owl: changed });
  });

  // `skip_download?`: Mastodon stores no emoji of a domain whose media it
  // rejects, so `from_text` finds none.
  it("shows no emoji of a server whose media is rejected", async () => {
    const host = "emoji-change-rejected.example";
    const blocked = await SELF.fetch("https://example.com/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: {
        ...(await authHeaders("emoji-reject-admin@example.com", { admin: true })),
        "content-type": "application/json",
      },
      body: JSON.stringify({ domain: host, severity: "noop", reject_media: true }),
    });
    expect(blocked.status).toBe(200);
    await blocked.arrayBuffer();
    const author = await remoteActor("mio", host);

    const first = await post(author, "first", "<p>:no:</p>", [
      emojiTag("no", `https://${host}/system/no.png`),
    ]);

    expect(await statusEmojis(first)).toEqual({});
  });

  // `ClearDomainMediaService#clear_emojos!`: a block that starts rejecting
  // media deletes the emoji of the domain and its subdomains.
  it("forgets a server's emoji when a block starts rejecting its media", async () => {
    const host = "emoji-change-cleared.example";
    const author = await remoteActor("noa", `sub.${host}`);
    const id = await post(author, "first", "<p>:gone:</p>", [
      emojiTag("gone", `https://sub.${host}/system/gone.png`),
    ]);
    expect(Object.keys(await statusEmojis(id))).toEqual(["gone"]);

    const blocked = await SELF.fetch("https://example.com/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: {
        ...(await authHeaders("emoji-clear-admin@example.com", { admin: true })),
        "content-type": "application/json",
      },
      body: JSON.stringify({ domain: host, severity: "noop", reject_media: true }),
    });
    expect(blocked.status).toBe(200);
    await blocked.arrayBuffer();

    expect(await statusEmojis(id)).toEqual({});
  });
});

describe("a known remote custom emoji a document writes without declaring it", () => {
  it("shows on a post of the emoji's server, written as `SCAN_RE` reads a shortcode", async () => {
    const host = "emoji-undeclared.example";
    const blob = `https://${host}/system/blob.png`;
    const alice = await remoteActor("alice", host);
    const bob = await remoteActor("bob", host);
    const elsewhere = await remoteActor("carol", "emoji-undeclared-elsewhere.example");
    await post(alice, "declared", "<p>:blob:</p>", [emojiTag("blob", blob)]);

    const undeclared = await post(bob, "undeclared", "<p>:blob: :unknown:</p>", []);
    expect(await statusEmojis(undeclared)).toEqual({ blob });
    const edited = await post(bob, "edited", "<p>plain</p>", []);
    const object = noteOf(bob, "edited", "<p>now :blob:</p>", [], {
      updated: "2026-11-21T00:00:00.000Z",
    });
    expect(await bob.send({ id: `${object.id}/update`, type: "Update", object })).toBe(202);
    expect(await statusEmojis(edited)).toEqual({ blob });
    expect(await historyEmojis(edited)).toEqual([{}, { blob }]);
    // A letter, digit or colon next to it is no shortcode; nor is a name of another case.
    const glued = await post(bob, "glued", "<p>x:blob: :blob:: :Blob:</p>", []);
    expect(await statusEmojis(glued)).toEqual({});
    // A declared emoji is read from the text the same way.
    const declaredGlued = await post(bob, "declared-glued", "<p>x:blob: :blob::</p>", [
      emojiTag("blob", blob),
    ]);
    expect(await statusEmojis(declaredGlued)).toEqual({});
    await updateProfile(bob, "Bob x:blob:", [emojiTag("blob", blob)]);
    expect(await accountEmojis(bob.actorUri)).toEqual({});
    // Onigmo's `[[:alnum:]]` holds the marks: a combining accent before it ends no word.
    const marked = await post(bob, "marked", "<p>é:blob:</p>", []);
    expect(await statusEmojis(marked)).toEqual({});
    // Another server's emoji of the same name is its own.
    const other = await post(elsewhere, "other", "<p>:blob:</p>", []);
    expect(await statusEmojis(other)).toEqual({});
  });

  // `EntityCache#emoji` looks each shortcode up as written, so `:Blob:` is
  // its own emoji, though the post declares `blob`.
  it("tells a shortcode from a declared one of another case", async () => {
    const host = "emoji-undeclared-case.example";
    const lower = `https://${host}/system/blob.png`;
    const upper = `https://${host}/system/Blob.png`;
    const alice = await remoteActor("alice", host);
    await post(alice, "upper", "<p>:Blob:</p>", [emojiTag("Blob", upper)]);

    const both = await post(alice, "both", "<p>:blob: :Blob:</p>", [emojiTag("blob", lower)]);
    expect(await statusEmojis(both)).toEqual({ blob: lower, Blob: upper });
  });

  // `process_emoji` stores each declared shortcode as written, and
  // `CustomEmoji.from_text` finds `:Blob:` only under `Blob`.
  it("shows no declared emoji for a shortcode written in another case", async () => {
    const host = "emoji-declared-case.example";
    const lower = `https://${host}/system/blob.png`;
    const upper = `https://${host}/system/Blob.png`;
    const alice = await remoteActor("alice", host);

    const other = await post(alice, "other-case", "<p>:Blob:</p>", [emojiTag("blob", lower)]);
    expect(await statusEmojis(other)).toEqual({});

    const poll = await postPoll(alice, "poll", [":Blob:", "no"], [emojiTag("blob", lower)]);
    expect(await statusEmojis(poll)).toEqual({});
    expect(await pollEmojis(poll)).toEqual({});

    // Both cases declared: each is its own emoji, the first not hiding the second.
    const both = await post(alice, "both-declared", "<p>:Blob:</p>", [
      emojiTag("blob", lower),
      emojiTag("Blob", upper),
    ]);
    expect(await statusEmojis(both)).toEqual({ Blob: upper });
  });

  it("shows on a profile of the emoji's server, and takes a new image", async () => {
    const host = "emoji-undeclared-profile.example";
    const old = `https://${host}/system/cat-1.png`;
    const changed = `https://${host}/system/cat-2.png`;
    const dana = await remoteActor("dana", host);
    const erin = await remoteActor("erin", host);
    await post(dana, "declared", "<p>:cat:</p>", [emojiTag("cat", old)]);

    await updateProfile(erin, "Erin :cat:", []);
    expect(await accountEmojis(erin.actorUri)).toEqual({ cat: old });
    const undeclared = await post(erin, "undeclared", "<p>:cat:</p>", []);

    await post(dana, "changed", "<p>:cat:</p>", [emojiTag("cat", changed)]);
    expect(await accountEmojis(erin.actorUri)).toEqual({ cat: changed });
    expect(await statusEmojis(undeclared)).toEqual({ cat: changed });
  });

  // `from_text` runs at each render, so a post or profile stored before its
  // server's emoji was known shows it once it is.
  it("shows an emoji learned after a post or profile that writes it was stored", async () => {
    const host = "emoji-learned-later.example";
    const image = `https://${host}/system/later.png`;
    const alice = await remoteActor("alice", host);
    const bob = await remoteActor("bob", host);
    const early = await post(bob, "early", "<p>:later:</p>", []);
    const poll = await postPoll(bob, "early-poll", [":later:", "no"]);
    await updateProfile(bob, "Bob :later:", []);
    expect(await statusEmojis(early)).toEqual({});
    expect(await pollEmojis(poll)).toEqual({});
    expect(await accountEmojis(bob.actorUri)).toEqual({});

    await post(alice, "teaches", "<p>:later:</p>", [emojiTag("later", image)]);

    expect(await statusEmojis(early)).toEqual({ later: image });
    expect(await statusEmojis(poll)).toEqual({ later: image });
    expect(await pollEmojis(poll)).toEqual({ later: image });
    expect(await accountEmojis(bob.actorUri)).toEqual({ later: image });
  });

  // `process_emoji` stores every `Emoji` tag a note declares, whether its
  // text writes it or not.
  it("learns an emoji a post declares without writing it", async () => {
    const host = "emoji-declared-unused.example";
    const image = `https://${host}/system/spare.png`;
    const alice = await remoteActor("alice", host);
    await post(alice, "declares", "<p>nothing here</p>", [emojiTag("spare", image)]);

    expect(await statusEmojis(await post(alice, "writes", "<p>:spare:</p>", []))).toEqual({
      spare: image,
    });
  });
});

/** The migration's statement that reads the copies stored with posts and profiles. */
const backfillStatement = (): string => {
  const statements = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("INSERT OR IGNORE INTO remote_custom_emojis"));
  expect(statements).toHaveLength(1);
  return statements[0] ?? "";
};

describe("migration 0180", () => {
  // Before 0170 tstodon kept only a copy of each emoji with the post or
  // profile; Mastodon holds the emoji itself, and shows its current image.
  it("reads the emoji of copies stored before 0170, keeping a newer image", async () => {
    const host = "emoji-pre-0170.example";
    const image = (name: string) => `https://${host}/system/${name}.png`;
    const author = await remoteActor("pia", host);
    const old = await post(author, "old", "<p>:replaced: :kept:</p>", []);
    await updateProfile(author, "Pia :profiled:", []);
    await env.DB.prepare(
      "ALTER TABLE remote_statuses ADD COLUMN emojis_json TEXT NOT NULL DEFAULT '[]'",
    ).run();
    try {
      await env.DB.batch([
        env.DB.prepare("UPDATE remote_statuses SET emojis_json = ?2 WHERE id = ?1").bind(
          old,
          JSON.stringify([
            { shortcode: "replaced", url: image("replaced-1") },
            { shortcode: "kept", url: image("kept") },
          ]),
        ),
        env.DB.prepare(
          "UPDATE remote_actors SET profile_json = json_set(profile_json, '$.emojis', json(?2)) WHERE actor_uri = ?1",
        ).bind(author.actorUri, JSON.stringify([{ shortcode: "profiled", url: image("prof") }])),
      ]);
      expect(await statusEmojis(old)).toEqual({});
      // Read since 0170 from a later post: the server's image now.
      await post(author, "new", "<p>:replaced:</p>", [emojiTag("replaced", image("replaced-2"))]);

      await env.DB.prepare(backfillStatement()).run();
    } finally {
      await env.DB.prepare("ALTER TABLE remote_statuses DROP COLUMN emojis_json").run();
    }

    expect(await statusEmojis(old)).toEqual({
      replaced: image("replaced-2"),
      kept: image("kept"),
    });
    expect(await accountEmojis(author.actorUri)).toEqual({ profiled: image("prof") });
  });
});

const NotificationEmojis = z.array(
  z.object({
    type: z.string(),
    status: z.object({ uri: z.string(), emojis: Emojis }).optional(),
    account: z.object({ emojis: Emojis }),
  }),
);

/** An admin disables or enables `domain`'s `shortcode` from `/admin/custom_emojis`. */
const setDisabled = async (domain: string, shortcode: string, disabled: boolean) => {
  const admin = await adminBrowser(`emoji_admin_${crypto.randomUUID().slice(0, 8)}`);
  const response = await admin.fetcher("/admin/custom_emojis", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([
      ["do", disabled ? "disable" : "enable"],
      ["emoji", `${domain}/${shortcode}`],
      ["by_domain", domain],
    ]).toString(),
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(
    `/admin/custom_emojis?remote=1&by_domain=${domain}&notice=${disabled ? "emojis_disabled" : "emojis_enabled"}`,
  );
};

describe("a disabled remote custom emoji", () => {
  // `CustomEmoji.enabled` in `EntityCache#emoji`; the admin's batch
  // `disable` and `enable` (`Form::CustomEmojiBatch`).
  it("shows nowhere until it is enabled again", async () => {
    const host = "emoji-disabled.example";
    const image = `https://${host}/system/off.png`;
    const author = await remoteActor("quinn", host);
    const reader = await signedInAccount("emoji-disabled-reader@example.com");
    const id = await post(author, "status", "<p>:off: @reader</p>", [
      emojiTag("off", image),
      { type: "Mention", href: `https://example.com/users/${reader.username}` },
    ]);
    const poll = await postPoll(author, "poll", [":off:", "on"]);
    await updateProfile(author, "Quinn :off:", []);
    await settle();
    const headers = await authHeaders("emoji-disabled-reader@example.com");
    const notified = async () => {
      const mention = read(NotificationEmojis, await get("/api/v1/notifications", headers)).find(
        (notification) =>
          notification.type === "mention" &&
          notification.status?.uri === `https://${host}/notes/status`,
      );
      expect(mention).toBeDefined();
      return {
        status: byShortcode(mention?.status?.emojis ?? []),
        account: byShortcode(mention?.account.emojis ?? []),
      };
    };
    const shown = { off: image };
    const everywhere = async () => ({
      status: await statusEmojis(id),
      poll: await pollEmojis(poll),
      account: await accountEmojis(author.actorUri),
      notification: await notified(),
    });
    expect(await everywhere()).toEqual({
      status: shown,
      poll: shown,
      account: shown,
      notification: { status: shown, account: shown },
    });

    await setDisabled(host, "off", true);
    expect(await everywhere()).toEqual({
      status: {},
      poll: {},
      account: {},
      notification: { status: {}, account: {} },
    });
    // A new image keeps it disabled, as `process_emoji` keeps `disabled`.
    await post(author, "again", "<p>:off:</p>", [
      emojiTag("off", `https://${host}/system/off-2.png`),
    ]);
    expect(await statusEmojis(id)).toEqual({});

    await setDisabled(host, "off", false);
    expect(await statusEmojis(id)).toEqual({ off: `https://${host}/system/off-2.png` });
  });
});

describe("the admin's list of remote custom emoji", () => {
  // `CustomEmojiFilter` with `by_domain` and `shortcode`, a page at a time in
  // `CustomEmoji.alphabetic` order.
  it("lists a domain's emoji a page at a time, filtered by shortcode", async () => {
    const host = "emoji-admin-list.example";
    const author = await remoteActor("rosa", host);
    const shortcodes = Array.from({ length: 27 }, (_, n) => `list${String(n).padStart(2, "0")}`);
    await post(
      author,
      "many",
      "<p>emoji</p>",
      shortcodes.map((shortcode) => emojiTag(shortcode, `https://${host}/system/${shortcode}.png`)),
    );
    await setDisabled(host, "list01", true);
    const admin = await adminBrowser(`emoji_lister_${crypto.randomUUID().slice(0, 8)}`);
    const listed = async (path: string) => {
      const response = await admin.fetcher(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      return {
        html,
        shortcodes: [...html.matchAll(/<strong>:([^:<]+):<\/strong>/g)].map((match) => match[1]),
        next: /<a href="([^"]+)">Next page<\/a>/.exec(html)?.[1]?.replaceAll("&amp;", "&"),
      };
    };

    const first = await listed(`/admin/custom_emojis?by_domain=${host}`);
    // Declared without being written, each is stored, as `process_emoji` stores every tag.
    expect(first.shortcodes).toEqual(shortcodes.slice(0, 25));
    expect(first.html).toContain(`${host} · Disabled`);
    expect(first.html).toContain(`${host} · Enabled`);
    const second = await listed(first.next ?? "");
    expect(second.shortcodes).toEqual(shortcodes.slice(25));
    expect(second.next).toBeUndefined();

    const searched = await listed("/admin/custom_emojis?remote=1&shortcode=ist2");
    expect(searched.shortcodes).toEqual(shortcodes.slice(20));
    // The local emoji alone: none of these.
    expect((await listed("/admin/custom_emojis?local=1&shortcode=ist2")).shortcodes).toEqual([]);
  });
});
