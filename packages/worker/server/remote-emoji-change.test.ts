import { SELF, env } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { CoveredHosts } from "@tstodon/domain";
import { adminBrowser } from "../test/admin-browser";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { signUp } from "../test/passkey-browser";
import { settle } from "../test/meter";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { withHostAddresses } from "../test/host-resolver-fixture";
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

/** How many emoji `remote_custom_emojis` holds for `domain`. */
const domainEmojis = async (domain: string): Promise<number> =>
  read(
    z.object({ n: z.number() }),
    await env.DB.prepare("SELECT count(*) AS n FROM remote_custom_emojis WHERE domain = ?")
      .bind(domain)
      .first(),
  ).n;

/** An admin makes a domain block. */
const blockDomain = async (body: Record<string, unknown>) => {
  const response = await SELF.fetch("https://example.com/api/v1/admin/domain_blocks", {
    method: "POST",
    headers: {
      ...(await authHeaders("emoji-block-admin@example.com", { admin: true })),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
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
    await blockDomain({ domain: host, severity: "noop", reject_media: true });
    const author = await remoteActor("mio", host);

    const first = await post(author, "first", "<p>:no:</p>", [
      emojiTag("no", `https://${host}/system/no.png`),
    ]);

    expect(await statusEmojis(first)).toEqual({});
  });

  // `ClearDomainMediaService#clear_emojos!` (a block that rejects media) and
  // `PurgeCustomEmojiWorker` (a suspension) delete the emoji of the domain
  // and its subdomains.
  it.each([
    ["rejects its media", "emoji-change-cleared.example", { severity: "noop", reject_media: true }],
    ["suspends it", "emoji-change-suspended.example", { severity: "suspend" }],
  ] as const)("forgets a server's emoji when a block %s", async (_, host, rule) => {
    const author = await remoteActor("noa", `sub.${host}`);
    await post(author, "first", "<p>:gone:</p>", [
      emojiTag("gone", `https://sub.${host}/system/gone.png`),
    ]);
    expect(await domainEmojis(`sub.${host}`)).toBe(1);

    await blockDomain({ domain: host, ...rule });

    expect(await domainEmojis(`sub.${host}`)).toBe(0);
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

  // A page binds every shortcode its posts write; one longer than
  // `MAX_SHORTCODE_SIZE` names no emoji, so a hostile post cannot make the
  // lookup too large to run for the posts beside it.
  it("ignores a hostile post's overlong shortcodes, showing the emoji beside it", async () => {
    const host = "emoji-hostile-shortcodes.example";
    const image = (name: string) => `https://${host}/system/${name.length}.png`;
    const longest = "x".repeat(128);
    const tooLong = "y".repeat(129);
    const author = await remoteActor("vic", host);
    // Declared, the one past the limit is not stored either.
    const fine = await post(author, "fine", `<p>:${longest}: :${tooLong}:</p>`, [
      emojiTag(longest, image(longest)),
      emojiTag(tooLong, image(tooLong)),
    ]);
    await env.DB.prepare(
      `INSERT INTO remote_custom_emojis (domain, shortcode, image_url, updated_at)
       VALUES (?1, ?2, ?3, '2020-01-01T00:00:00.000Z')`,
    )
      .bind(host, tooLong, image(tooLong))
      .run();
    const hostile = await post(author, "hostile", "<p>long</p>", []);
    const long = Array.from({ length: 50 }, (_, n) => `:${String(n).padStart(20_000, "x")}:`);
    await env.DB.prepare("UPDATE remote_statuses SET content_html = ?2 WHERE id = ?1")
      .bind(hostile, `<p>${long.join(" ")} :${longest}:</p>`)
      .run();

    const shown = read(
      z.array(z.object({ id: z.string(), emojis: Emojis })),
      await get(`/api/v1/statuses?id[]=${fine}&id[]=${hostile}`),
    );
    expect(
      Object.fromEntries(shown.map((status) => [status.id, byShortcode(status.emojis)])),
    ).toEqual({
      [fine]: { [longest]: image(longest) },
      [hostile]: { [longest]: image(longest) },
    });
  });

  // Of a list of tags longer than is stored, those the post writes are kept.
  it("records the emoji a post writes though it declares many more", async () => {
    const host = "emoji-many-tags.example";
    const author = await remoteActor("wen", host);
    const tags = Array.from({ length: 60 }, (_, n) =>
      emojiTag(`spare${n}`, `https://${host}/system/spare${n}.png`),
    );
    const id = await post(author, "many", "<p>:spare59:</p>", tags);

    expect(await statusEmojis(id)).toEqual({ spare59: `https://${host}/system/spare59.png` });
    expect(await domainEmojis(host)).toBe(50);
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
    // The batch form keeps the page it is on, and the redirect goes back to it.
    const after = /<input type="hidden" name="after" value="([^"]+)" \/>/.exec(second.html)?.[1];
    expect(after).toBe(`${host}/list24`);
    const changed = await admin.fetcher("/admin/custom_emojis", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([
        ["do", "disable"],
        ["emoji", `${host}/list25`],
        ["remote", "1"],
        ["by_domain", host],
        ["after", after ?? ""],
      ]).toString(),
    });
    expect(changed.status).toBe(303);
    expect(changed.headers.get("location")).toBe(
      `/admin/custom_emojis?${new URLSearchParams([
        ["remote", "1"],
        ["by_domain", host],
        ["after", `${host}/list24`],
        ["notice", "emojis_disabled"],
      ]).toString()}`,
    );
    expect((await listed(changed.headers.get("location") ?? "")).html).toContain(
      `${host} · Disabled`,
    );

    const searched = await listed("/admin/custom_emojis?remote=1&shortcode=ist2");
    expect(searched.shortcodes).toEqual(shortcodes.slice(20));
    // The local emoji alone: none of these.
    expect((await listed("/admin/custom_emojis?local=1&shortcode=ist2")).shortcodes).toEqual([]);
  });

  it("refuses a batch action of an account that is not an admin", async () => {
    const host = "emoji-admin-refused.example";
    const image = `https://${host}/system/kept.png`;
    const author = await remoteActor("sol", host);
    const id = await post(author, "kept", "<p>:kept:</p>", [emojiTag("kept", image)]);
    const { fetcher } = await signUp(`emoji_user_${crypto.randomUUID().slice(0, 8)}`);

    for (const action of ["disable", "enable", "copy", "delete"]) {
      const response = await fetcher("/admin/custom_emojis", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams([
          ["do", action],
          ["emoji", `${host}/kept`],
        ]).toString(),
      });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    expect(await statusEmojis(id)).toEqual({ kept: image });
  });
});

/** Answer GETs of the URLs `images` names with its responses while a test runs; the URLs fetched. */
const serveImages = (images: Readonly<Record<string, () => Response>>): ReadonlyArray<string> => {
  const fetched: string[] = [];
  const original = globalThis.fetch;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetched.push(href);
      const answer = images[href];
      return answer === undefined ? original(input, init) : answer();
    });
  onTestFinished(() => spy.mockRestore());
  return fetched;
};

const imageAnswer =
  (bytes: ReadonlyArray<number>, type = "image/png") =>
  () =>
    new Response(new Uint8Array(bytes), { headers: { "content-type": type } });

/** An admin's batch action on `domain`'s remote emoji `shortcodes`, from the list of its emoji; the notice. */
const batch = async (action: string, domain: string, shortcodes: ReadonlyArray<string>) => {
  const admin = await adminBrowser(`emoji_batch_${crypto.randomUUID().slice(0, 8)}`);
  const response = await admin.fetcher("/admin/custom_emojis", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([
      ["do", action],
      ...shortcodes.map((shortcode): [string, string] => ["emoji", `${domain}/${shortcode}`]),
      ["remote", "1"],
      ["by_domain", domain],
    ]).toString(),
  });
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("location") ?? "", "https://example.com");
  expect(location.pathname).toBe("/admin/custom_emojis");
  expect(location.searchParams.get("by_domain")).toBe(domain);
  return location.searchParams.get("notice");
};

const LocalEmojis = z.array(
  z.object({
    id: z.string(),
    shortcode: z.string(),
    url: z.string(),
    visible_in_picker: z.boolean(),
    category: z.string().optional(),
  }),
);

const ADMIN_EMAIL = "emoji-copy-admin@example.com";

const localEmojis = async () =>
  Object.fromEntries(
    read(
      LocalEmojis,
      await get("/api/v1/admin/custom_emojis", await authHeaders(ADMIN_EMAIL, { admin: true })),
    ).map((emoji) => [emoji.shortcode, emoji]),
  );

/** The bytes the instance serves at a local emoji's URL. */
const served = async (url: string): Promise<ReadonlyArray<number>> => {
  const response = await SELF.fetch(url);
  expect(response.status).toBe(200);
  return [...new Uint8Array(await response.arrayBuffer())];
};

describe("an admin's copy of a remote custom emoji", () => {
  // `Form::CustomEmojiBatch#copy!` and `CustomEmoji#copy!`: the local emoji of
  // the same shortcode (`find_or_initialize_by(domain: nil, shortcode:)`)
  // takes the image; a new one has no category and shows in the picker.
  it("downloads the image into a local emoji, replacing the image of one of its shortcode", async () => {
    const host = "emoji-copy.example";
    const author = await remoteActor("tove", host);
    const id = await post(author, "copy", "<p>:copyfresh: :copytaken:</p>", [
      emojiTag("copyfresh", `https://${host}/system/fresh.png`),
      emojiTag("copytaken", `https://${host}/system/taken.gif`),
    ]);
    const form = new FormData();
    form.set("shortcode", "copytaken");
    form.set("category", "Kept");
    form.set("visible_in_picker", "false");
    form.set("image", new File([new Uint8Array([1])], "old.png", { type: "image/png" }));
    const uploaded = await SELF.fetch("https://example.com/api/v1/admin/custom_emojis", {
      method: "POST",
      headers: await authHeaders(ADMIN_EMAIL, { admin: true }),
      body: form,
    });
    expect(uploaded.status).toBe(200);
    await uploaded.arrayBuffer();
    const before = await localEmojis();
    serveImages({
      [`https://${host}/system/fresh.png`]: imageAnswer([137, 80, 78, 71, 1]),
      [`https://${host}/system/taken.gif`]: imageAnswer([71, 73, 70], "image/gif"),
    });

    expect(await batch("copy", host, ["copyfresh", "copytaken"])).toBe("emojis_copied");

    const after = await localEmojis();
    expect(after.copyfresh).toMatchObject({ visible_in_picker: true });
    expect(after.copyfresh?.category).toBeUndefined();
    expect(await served(after.copyfresh?.url ?? "")).toEqual([137, 80, 78, 71, 1]);
    expect(after.copytaken).toMatchObject({
      id: before.copytaken?.id,
      category: "Kept",
      visible_in_picker: false,
    });
    expect(after.copytaken?.url).not.toBe(before.copytaken?.url);
    expect(await served(after.copytaken?.url ?? "")).toEqual([71, 73, 70]);
    const listed = read(
      z.array(z.object({ shortcode: z.string() })),
      await get("/api/v1/custom_emojis"),
    ).map((emoji) => emoji.shortcode);
    expect(listed).toContain("copyfresh");
    // The remote emoji stays, and the remote post still shows it.
    expect(await statusEmojis(id)).toEqual({
      copyfresh: `https://${host}/system/fresh.png`,
      copytaken: `https://${host}/system/taken.gif`,
    });
  });

  // `CustomEmoji::LIMIT` and `IMAGE_MIME_TYPES`, and the federated fetch's
  // refusal of a private address.
  it("copies no image too large, of another type, missing or on a private address", async () => {
    const host = "emoji-copy-refused.example";
    const privateHost = "emoji-copy-private.example";
    const author = await remoteActor("ulla", host);
    const privateAuthor = await remoteActor("ulf", privateHost);
    await post(author, "refused", "<p>emoji</p>", [
      emojiTag("copybig", `https://${host}/system/big.png`),
      emojiTag("copysvg", `https://${host}/system/vector.svg`),
      emojiTag("copygone", `https://${host}/system/gone.png`),
    ]);
    await post(privateAuthor, "private", "<p>emoji</p>", [
      emojiTag("copyprivate", `https://${privateHost}/system/private.png`),
    ]);
    const fetched = serveImages({
      [`https://${host}/system/big.png`]: imageAnswer(
        Array.from({ length: 256 * 1024 + 1 }, () => 0),
      ),
      [`https://${host}/system/vector.svg`]: imageAnswer([60, 115, 118, 103], "image/svg+xml"),
      [`https://${host}/system/gone.png`]: () => new Response("gone", { status: 404 }),
      [`https://${privateHost}/system/private.png`]: imageAnswer([137, 80, 78, 71]),
    });

    await withHostAddresses({ [privateHost]: ["10.0.0.1"] }, async () => {
      expect(await batch("copy", host, ["copybig", "copysvg", "copygone", "copynosuch"])).toBe(
        "emoji_copy_failed",
      );
      expect(await batch("copy", privateHost, ["copyprivate"])).toBe("emoji_copy_failed");
    });

    const local = Object.keys(await localEmojis());
    for (const shortcode of ["copybig", "copysvg", "copygone", "copyprivate"]) {
      expect(local).not.toContain(shortcode);
    }
    expect(fetched).not.toContain(`https://${privateHost}/system/private.png`);
  });
});

describe("an admin's deletion of a remote custom emoji", () => {
  // `Form::CustomEmojiBatch#delete!`: the posts and profiles that write it
  // show its shortcode, until a document that declares it stores it again.
  it("shows the emoji nowhere until a document declares it again", async () => {
    const host = "emoji-delete.example";
    const gone = `https://${host}/system/gone.png`;
    const kept = `https://${host}/system/kept.png`;
    const author = await remoteActor("vera", host);
    const id = await post(author, "delete", "<p>:delgone: :delkept:</p>", [
      emojiTag("delgone", gone),
      emojiTag("delkept", kept),
    ]);
    await updateProfile(author, "Vera :delgone:", [emojiTag("delgone", gone)]);
    expect(await accountEmojis(author.actorUri)).toEqual({ delgone: gone });

    expect(await batch("delete", host, ["delgone"])).toBe("emojis_deleted");

    expect(await statusEmojis(id)).toEqual({ delkept: kept });
    expect(await accountEmojis(author.actorUri)).toEqual({});
    expect(await domainEmojis(host)).toBe(1);

    await post(author, "again", "<p>:delgone:</p>", [emojiTag("delgone", gone)]);
    expect(await statusEmojis(id)).toEqual({ delgone: gone, delkept: kept });
    expect(await accountEmojis(author.actorUri)).toEqual({ delgone: gone });
  });
});
