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

  it("leaves out an emoji without a name or an http(s) image, and drops them when the tags go", async () => {
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
    expect((await account(author.actorUri)).emojis).toEqual([]);
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
