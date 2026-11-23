import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiAccount, ApiCredentialAccount } from "@tstodon/api";
import { z } from "zod";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";

const ORIGIN = "https://example.com";

/** Mastodon's `TextFormatter.link_to_mention`. */
const hCard = (url: string, shown: string): string =>
  `<span class="h-card" translate="no"><a href="${url}" class="u-url mention">@<span>${shown}</span></a></span>`;

const ActorAttachments = z.object({
  attachment: z.array(z.object({ name: z.string(), value: z.string() })),
});

const updateFields = async (email: string, fields: ReadonlyArray<[string, string]>) => {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/accounts/update_credentials`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ fields_attributes: fields.map(([name, value]) => ({ name, value })) }),
  });
  expect(response.status).toBe(200);
  return expectContract(ApiCredentialAccount, await response.json());
};

const actorAttachments = async (username: string) => {
  const response = await SELF.fetch(`${ORIGIN}/users/${username}`, {
    headers: { Accept: "application/activity+json" },
  });
  expect(response.status).toBe(200);
  return ActorAttachments.parse(await response.json()).attachment.map((entry) => entry.value);
};

describe("a mention in a local profile field", () => {
  it("links a local or known remote account as Mastodon's account_field_value_format, in the REST account and the actor", async () => {
    const email = "field-mentions@example.com";
    const account = await signedInAccount(email);
    const friend = await signedInAccount("field-mentions-friend@example.com");
    const carolProfile = "https://fields-mention.example/@carol";
    await remoteActor("carol", "fields-mention.example", { profileUrl: carolProfile });

    const updated = await updateFields(email, [
      ["friend", `@${friend.username}`],
      ["remote", "@carol@fields-mention.example"],
      ["unknown", "@nobody@nowhere.example and @no_such_local_account"],
      ["mixed", `see @${friend.username.toUpperCase()}@EXAMPLE.com #Tea https://tea.org`],
    ]);
    const friendLink = hCard(`${ORIGIN}/@${friend.username}`, friend.username);
    const expected = [
      friendLink,
      // `with_domains: true`: a remote account shows its domain.
      hCard(carolProfile, "carol@fields-mention.example"),
      "@nobody@nowhere.example and @no_such_local_account",
      `see ${friendLink} <a href="${ORIGIN}/tags/tea" class="mention hashtag" rel="tag">#<span>Tea</span></a> <a href="https://tea.org" target="_blank" rel="nofollow noopener me" translate="no"><span class="invisible">https://</span><span class="">tea.org</span><span class="invisible"></span></a>`,
    ];
    expect(updated.fields.map((field) => field.value)).toEqual(expected);
    expect(updated.source.fields[1]?.value).toBe("@carol@fields-mention.example");

    const shown = await SELF.fetch(`${ORIGIN}/api/v1/accounts/${account.id}`);
    expect(expectContract(ApiAccount, await shown.json()).fields.map((f) => f.value)).toEqual(
      expected,
    );
    expect(await actorAttachments(account.username)).toEqual(expected);
  });
});
