import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApEmojiDocument, ApStatusDocument, ApStatusObject } from "@tstodon/api/activitypub";
import { authHeaders } from "../test/auth-fixture";

const Created = z.object({
  id: z.string(),
  uri: z.string(),
  account: z.object({ id: z.string() }),
  emojis: z.array(z.object({ shortcode: z.string() })),
});
const AdminEmoji = z.object({ id: z.string(), url: z.string() });
const Payload = z.object({ object: ApStatusObject });

const uploadEmoji = async (email: string, shortcode: string) => {
  const form = new FormData();
  form.set("shortcode", shortcode);
  form.set(
    "image",
    new File([new Uint8Array([137, 80, 78, 71])], "emoji.png", { type: "image/png" }),
  );
  const response = await SELF.fetch("https://example.com/api/v1/admin/custom_emojis", {
    method: "POST",
    headers: await authHeaders(email, { admin: true }),
    body: form,
  });
  expect(response.status).toBe(200);
  return AdminEmoji.parse(await response.json());
};

const post = async (email: string, body: Record<string, unknown>) => {
  const response = await SELF.fetch("https://example.com/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return Created.parse(await response.json());
};

const noteDocument = async (uri: string) => {
  const response = await SELF.fetch(uri, { headers: { accept: "application/activity+json" } });
  expect(response.status).toBe(200);
  return ApStatusDocument.parse(await response.json());
};

/** An admin-managed emoji's tag, as Mastodon's `ActivityPub::EmojiSerializer` writes it. */
const storedTag = (
  emoji: z.infer<typeof AdminEmoji>,
  shortcode: string,
  mediaType = "image/png",
) => ({
  id: `https://example.com/emojis/${emoji.id}`,
  type: "Emoji",
  name: `:${shortcode}:`,
  updated: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  icon: { type: "Image", mediaType, url: emoji.url },
});

const emojiTags = (document: Pick<z.infer<typeof ApStatusObject>, "tag">) =>
  document.tag.filter((tag) => tag.type === "Emoji");

describe("custom emoji in a federated note", () => {
  it("names each emoji the text, the content warning and the poll use, as an Emoji tag", async () => {
    const email = "note-emoji@example.com";
    const wave = await uploadEmoji(email, "notewave");
    const warn = await uploadEmoji(email, "notewarn");
    const vote = await uploadEmoji(email, "notevote");
    await uploadEmoji(email, "noteunused");

    const sent = await post(email, {
      status: "hi :notewave: and :notewave: again, not :nosuchemoji:",
      spoiler_text: "careful :notewarn:",
      poll: { options: ["yes :notevote:", "no"], expires_in: 3600 },
    });

    // In the order `Status#emojis` scans them: the content warning, the text, the poll.
    const expected = [
      storedTag(warn, "notewarn"),
      storedTag(wave, "notewave"),
      storedTag(vote, "notevote"),
    ];
    const served = await noteDocument(sent.uri);
    expect(emojiTags(served)).toEqual(expected);
    expect(served["@context"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ Emoji: "toot:Emoji" })]),
    );

    // The `Create` Mastodon receives carries the same tags.
    const row = await env.DB.prepare(
      "SELECT payload_json FROM outbound_activities WHERE account_id = ? AND kind = 'Create'",
    )
      .bind(sent.account.id)
      .first();
    const stored = z.object({ payload_json: z.string() }).parse(row);
    expect(emojiTags(Payload.parse(JSON.parse(stored.payload_json)).object)).toEqual(expected);
  });

  it("carries no Emoji tag and no Emoji term for a note without custom emoji", async () => {
    const sent = await post("note-no-emoji@example.com", { status: "plain :notanemoji: text" });
    const served = await noteDocument(sent.uri);
    expect(emojiTags(served)).toEqual([]);
    expect(JSON.stringify(served["@context"])).not.toContain("toot:Emoji");
  });

  // Mastodon looks a shortcode up as written (`CustomEmoji.from_text`), and
  // matches a tag's name against the text the same way.
  it("matches a shortcode in the case it is written, so a tag's name is in the text", async () => {
    const email = "note-emoji-case@example.com";
    const wave = await uploadEmoji(email, "casewave");

    const other = await post(email, { status: "shouting :CaseWave: and :CASEWAVE:" });
    expect(emojiTags(await noteDocument(other.uri))).toEqual([]);
    expect(other.emojis).toEqual([]);

    const same = await post(email, { status: "saying :casewave: after :CaseWave:" });
    expect(emojiTags(await noteDocument(same.uri))).toEqual([storedTag(wave, "casewave")]);
    expect(same.emojis.map((emoji) => emoji.shortcode)).toEqual(["casewave"]);
  });

  // Mastodon fetches a remote emoji's image again only when the tag names
  // another URL (`process_emoji`), so a new image has to come under a new one.
  it("names a replaced image by a new URL, in earlier notes too, and serves the old one no more", async () => {
    const email = "note-emoji-replaced@example.com";
    const before = await uploadEmoji(email, "replacedwave");
    const sent = await post(email, { status: "hi :replacedwave:" });

    const replacement = new FormData();
    replacement.set(
      "image",
      new File([new Uint8Array([71, 73, 70, 56])], "emoji.gif", { type: "image/gif" }),
    );
    const replaced = await SELF.fetch(
      `https://example.com/api/v1/admin/custom_emojis/${before.id}`,
      { method: "PATCH", headers: await authHeaders(email, { admin: true }), body: replacement },
    );
    expect(replaced.status).toBe(200);
    const after = AdminEmoji.parse(await replaced.json());
    expect(after.id).toBe(before.id);
    expect(after.url).not.toBe(before.url);

    expect(emojiTags(await noteDocument(sent.uri))).toEqual([
      storedTag(after, "replacedwave", "image/gif"),
    ]);
    const shown = await SELF.fetch(`https://example.com/api/v1/statuses/${sent.id}`);
    expect(
      z
        .object({ emojis: z.array(z.object({ url: z.string() })) })
        .parse(await shown.json())
        .emojis.map((emoji) => emoji.url),
    ).toEqual([after.url]);

    const served = (url: string) => SELF.fetch(`https://example.com${new URL(url).pathname}`);
    const image = await served(after.url);
    expect(image.headers.get("content-type")).toBe("image/gif");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([71, 73, 70, 56]);
    const gone = await served(before.url);
    expect(gone.status).toBe(404);
    await gone.arrayBuffer();
  });
});

const EmojiDocument = ApEmojiDocument.extend({ updated: z.string() });

const emojiDocument = async (id: string) => {
  const response = await SELF.fetch(`https://example.com/emojis/${id}`, {
    headers: { accept: "application/activity+json" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/activity+json");
  expect(response.headers.get("cache-control")).toBe("max-age=180, public");
  return EmojiDocument.parse(await response.json());
};

// `EmojisController#show`: a local emoji's own document, which the `id` of
// its tag names.
describe("GET /emojis/:id", () => {
  it("serves the document the tag names, with the same id and date", async () => {
    const email = "emoji-document@example.com";
    const emoji = await uploadEmoji(email, "documentwave");
    const sent = await post(email, { status: "hi :documentwave:" });
    const [tag] = emojiTags(await noteDocument(sent.uri));

    const document = await emojiDocument(emoji.id);
    expect(document).toEqual({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        { toot: "http://joinmastodon.org/ns#", Emoji: "toot:Emoji" },
      ],
      ...storedTag(emoji, "documentwave"),
    });
    expect(tag).toEqual(expect.objectContaining({ id: document.id, updated: document.updated }));
  });

  // Rails' `iso8601` writes whole seconds; a change of the emoji moves it.
  it("dates the document by the emoji's last change, to the second", async () => {
    const email = "emoji-document-date@example.com";
    const emoji = await uploadEmoji(email, "documentdate");
    await env.DB.prepare("UPDATE custom_emojis SET updated_at = ? WHERE id = ?")
      .bind("2026-01-02T03:04:05.678Z", emoji.id)
      .run();
    expect((await emojiDocument(emoji.id)).updated).toBe("2026-01-02T03:04:05Z");

    const change = new FormData();
    change.set("visible_in_picker", "false");
    const changed = await SELF.fetch(`https://example.com/api/v1/admin/custom_emojis/${emoji.id}`, {
      method: "PATCH",
      headers: await authHeaders(email, { admin: true }),
      body: change,
    });
    expect(changed.status).toBe(200);
    await changed.arrayBuffer();
    expect(Date.parse((await emojiDocument(emoji.id)).updated)).toBeGreaterThan(
      Date.parse("2026-01-02T03:04:05Z"),
    );
  });

  it("answers 404 for an id no emoji has", async () => {
    const response = await SELF.fetch("https://example.com/emojis/nosuchemoji");
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });
});
