import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApStatusDocument, ApStatusObject } from "@tstodon/api/activitypub";
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

    const expected = [
      { type: "Emoji", name: ":notewave:", icon: { type: "Image", url: wave.url } },
      { type: "Emoji", name: ":notewarn:", icon: { type: "Image", url: warn.url } },
      { type: "Emoji", name: ":notevote:", icon: { type: "Image", url: vote.url } },
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
    expect(emojiTags(await noteDocument(same.uri))).toEqual([
      { type: "Emoji", name: ":casewave:", icon: { type: "Image", url: wave.url } },
    ]);
    expect(same.emojis.map((emoji) => emoji.shortcode)).toEqual(["casewave"]);
  });
});
