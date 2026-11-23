import { SELF, env } from "cloudflare:test";
import { ApiAccount, type ApiAccountJSON } from "@tstodon/api";
import { describe, expect, it } from "vite-plus/test";
import { expectContract } from "../test/api-contract";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const account = async (actorUri: string): Promise<ApiAccountJSON> => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`,
  );
  expect(response.status).toBe(200);
  return expectContract(ApiAccount, await response.json());
};

/** The actor's own `Update` of its profile, as Mastodon sends one after a profile edit. */
const updateProfile = async (author: Remote, profile: Record<string, unknown>): Promise<void> => {
  expect(
    await author.send({
      id: `${author.actorUri}#updates/${crypto.randomUUID()}`,
      type: "Update",
      object: {
        id: author.actorUri,
        type: "Person",
        preferredUsername: author.actorUri.split("/").pop(),
        inbox: `${author.actorUri}/inbox`,
        publicKey: {
          id: `${author.actorUri}#main-key`,
          owner: author.actorUri,
          publicKeyPem: author.publicKeyPem,
        },
        ...profile,
      },
    }),
  ).toBe(202);
};

const emojiTag = (name: string, url: unknown = `https://remote.example/emoji/${name}.png`) => ({
  id: `https://remote.example/emojis/${name}`,
  type: "Emoji",
  name: `:${name}:`,
  icon: { type: "Image", mediaType: "image/png", url },
});

const emoji = (shortcode: string) => ({
  shortcode,
  url: `https://remote.example/emoji/${shortcode}.png`,
  static_url: `https://remote.example/emoji/${shortcode}.png`,
  visible_in_picker: false,
});

describe("the custom emoji of a remote account", () => {
  it("lists the emoji the display name and the bio write, in the case they are written", async () => {
    const author = await remoteActor("emoji-profile");
    await updateProfile(author, {
      name: ":blobcat: Name",
      summary: "<p>bio :Party: and :missing:</p>",
      tag: [
        emojiTag("blobcat"),
        emojiTag("party"),
        emojiTag("Party"),
        emojiTag("unused"),
        { type: "Hashtag", name: "#blobcat", href: "https://remote.example/tags/blobcat" },
      ],
    });
    const shown = await account(author.actorUri);
    expect(shown.display_name).toBe(":blobcat: Name");
    expect(shown.note).toContain(":Party:");
    expect(shown.emojis).toEqual([emoji("blobcat"), emoji("Party")]);
  });

  // With its tags gone, the name still writes `:ok:`, which Mastodon knows
  // for the actor's domain (`CustomEmoji.from_text`).
  it("leaves out an emoji without a name or an http(s) image, and drops them when the text goes", async () => {
    const author = await remoteActor("emoji-profile-invalid");
    await updateProfile(author, {
      name: ":ok: :script: :nameless:",
      tag: [
        emojiTag("ok"),
        emojiTag("script", "javascript:alert(1)"),
        { type: "Emoji", icon: { url: "https://remote.example/emoji/nameless.png" } },
      ],
    });
    expect((await account(author.actorUri)).emojis).toEqual([emoji("ok")]);

    await updateProfile(author, { name: ":ok: still" });
    expect((await account(author.actorUri)).emojis).toEqual([emoji("ok")]);

    await updateProfile(author, { name: "no emoji" });
    expect((await account(author.actorUri)).emojis).toEqual([]);
  });

  it("reads a single Emoji object where a list is usual", async () => {
    const author = await remoteActor("emoji-profile-single");
    await updateProfile(author, { name: ":solo: Name", tag: emojiTag("solo") });
    expect((await account(author.actorUri)).emojis).toEqual([emoji("solo")]);
  });

  it("leaves out an emoji whose image URL is longer than 2048 characters", async () => {
    const author = await remoteActor("emoji-profile-long-url");
    const url = (length: number) =>
      `https://remote.example/emoji/${"a".repeat(length - "https://remote.example/emoji/.png".length)}.png`;
    await updateProfile(author, {
      name: ":fits: :long:",
      tag: [emojiTag("fits", url(2048)), emojiTag("long", url(2049))],
    });
    expect((await account(author.actorUri)).emojis).toEqual([
      { shortcode: "fits", url: url(2048), static_url: url(2048), visible_in_picker: false },
    ]);
  });

  it("reads a profile stored before emoji were kept", async () => {
    const author = await remoteActor("emoji-profile-old-row");
    await env.DB.prepare("UPDATE remote_actors SET profile_json = ? WHERE actor_uri = ?")
      .bind(
        JSON.stringify({
          note: "an old bio",
          avatarUrl: null,
          headerUrl: null,
          profileUrl: null,
          locked: true,
          bot: false,
          publishedAt: null,
        }),
        author.actorUri,
      )
      .run();
    const shown = await account(author.actorUri);
    expect(shown.note).toContain("an old bio");
    expect(shown.locked).toBe(true);
    expect(shown.emojis).toEqual([]);
    expect(shown.fields).toEqual([]);
  });
});

describe("the bio of a remote account", () => {
  it("stores an actor whose summary has a character reference outside Unicode", async () => {
    const author = await remoteActor("bio-bad-reference");
    await updateProfile(author, {
      name: "Bad reference",
      summary:
        "<p>over &#x110000; huge &#99999999999999999999; half &#xD800; nul &#0; fine &#x41;&#66;</p>",
    });
    const shown = await account(author.actorUri);
    expect(shown.display_name).toBe("Bad reference");
    expect(shown.note).toContain("over \ufffd huge \ufffd half \ufffd nul \ufffd fine AB");
  });
});

const field = (name: unknown, value: unknown) => ({ type: "PropertyValue", name, value });

describe("the profile fields of a remote account", () => {
  it("lists the PropertyValue attachments in order, the value sanitised", async () => {
    const author = await remoteActor("fields-profile");
    await updateProfile(author, {
      name: "Fields",
      attachment: [
        field("Pronouns", "  they/them  "),
        { type: "Note", name: "not a field", value: "skipped" },
        field(
          "Site",
          '<a href="https://example.com/" rel="me" onclick="steal()">example.com</a><script>alert(1)</script>',
        ),
        field(7, "a name that is no text"),
        field("No value", null),
      ],
    });
    const { fields } = await account(author.actorUri);
    expect(fields.map((entry) => entry.name)).toEqual(["Pronouns", "Site"]);
    expect(fields[0]).toEqual({ name: "Pronouns", value: "they/them", verified_at: null });
    expect(fields[1]?.value).toContain('href="https://example.com/"');
    expect(fields[1]?.value).not.toMatch(/onclick|<script/);
    expect(fields[1]?.verified_at).toBeNull();
  });

  it("takes fifty fields and 2047 characters of a name and a value, as Mastodon does", async () => {
    const author = await remoteActor("fields-profile-limits");
    await updateProfile(author, {
      attachment: [
        field("n".repeat(3000), "v".repeat(3000)),
        ...Array.from({ length: 60 }, (_, index) => field(`field ${index}`, "x")),
      ],
    });
    const { fields } = await account(author.actorUri);
    expect(fields).toHaveLength(50);
    expect(fields[0]?.name).toBe("n".repeat(2047));
    expect(fields[0]?.value).toBe("v".repeat(2047));
    expect(fields[49]?.name).toBe("field 48");
  });

  it("lists the emoji a field writes, and drops the fields when the attachments go", async () => {
    const author = await remoteActor("fields-profile-emoji");
    await updateProfile(author, {
      attachment: [field(":label: Mood", "<p>:mood:</p>")],
      tag: [emojiTag("label"), emojiTag("mood"), emojiTag("unused")],
    });
    const shown = await account(author.actorUri);
    expect(shown.fields).toEqual([
      { name: ":label: Mood", value: "<p>:mood:</p>", verified_at: null },
    ]);
    expect(shown.emojis).toEqual([emoji("label"), emoji("mood")]);

    await updateProfile(author, { name: "No fields" });
    expect((await account(author.actorUri)).fields).toEqual([]);
  });
});

describe("the discoverable and indexable flags of a remote account", () => {
  it("shows the flags the actor document sets, as Mastodon's ProcessAccountService", async () => {
    const author = await remoteActor("flags-profile");
    const unset = await account(author.actorUri);
    expect([unset.discoverable, unset.indexable]).toEqual([false, false]);

    await updateProfile(author, { discoverable: true, indexable: true });
    const opted = await account(author.actorUri);
    expect([opted.discoverable, opted.indexable]).toEqual([true, true]);

    await updateProfile(author, { discoverable: false });
    const withdrawn = await account(author.actorUri);
    expect([withdrawn.discoverable, withdrawn.indexable]).toEqual([false, false]);
  });

  // Mastodon stores `@json['discoverable'] || false` in a boolean column,
  // which Rails casts: "false", "0", "off" and 0 are false, another value true.
  it("reads a flag that is not a boolean as Rails casts it, and keeps the actor", async () => {
    const author = await remoteActor("flags-odd");
    await updateProfile(author, { name: "Odd flags", discoverable: "yes", indexable: "false" });
    const shown = await account(author.actorUri);
    expect(shown.display_name).toBe("Odd flags");
    expect([shown.discoverable, shown.indexable]).toEqual([true, false]);

    await updateProfile(author, { discoverable: 0, indexable: null });
    const cast = await account(author.actorUri);
    expect([cast.discoverable, cast.indexable]).toEqual([false, false]);
  });
});
