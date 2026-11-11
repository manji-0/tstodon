import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiStatus } from "@tstodon/api";
import { ApStatusDocument } from "@tstodon/api/activitypub";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

const ORIGIN = "https://example.com";
const LONG_URL = "https://example.com/a/very/long/path/over/thirty/chars";
const LONG_LINK =
  `<a href="${LONG_URL}" target="_blank" rel="nofollow noopener" translate="no">` +
  `<span class="invisible">https://</span><span class="ellipsis">example.com/a/very/long/path/o</span>` +
  `<span class="invisible">ver/thirty/chars</span></a>`;

const send = async (email: string, method: string, path: string, body: Record<string, unknown>) => {
  const response = await SELF.fetch(new URL(path, ORIGIN), {
    method,
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return expectContract(ApiStatus, await response.json());
};

/** What Mastodon's TextFormatter makes of `hi @{bob} @{ghost} #Cat {LONG_URL}\n\nsecond <b>`. */
const expectFormatted = (
  content: string,
  bob: Readonly<{ username: string; url: string }>,
  ghost: string,
) => {
  expect(content).toBe(
    `<p>hi <span class="h-card" translate="no"><a href="${bob.url}" class="u-url mention">@<span>${bob.username}</span></a></span>` +
      ` @${ghost} <a href="${ORIGIN}/tags/cat" class="mention hashtag" rel="tag">#<span>Cat</span></a>` +
      ` ${LONG_LINK}</p><p>second &lt;b&gt;</p>`,
  );
};

describe("a local post's HTML", () => {
  it("links URLs, hashtags and resolved mentions when posted, edited and federated", async () => {
    const email = "post-format-author@example.com";
    const author = await signedInAccount(email);
    const bob = await signedInAccount("post-format-bob@example.com");
    const carol = await signedInAccount("post-format-carol@example.com");
    const ghost = "post_format_ghost";
    const text = (mentioned: string) => `hi @${mentioned} @${ghost} #Cat ${LONG_URL}\n\nsecond <b>`;

    const posted = await send(email, "POST", "/api/v1/statuses", { status: text(bob.username) });
    expect(posted.mentions).toHaveLength(1);
    const bobUrl = posted.mentions[0]?.url ?? "";
    expect(bobUrl).toBe(`${ORIGIN}/users/${bob.username}`);
    expectFormatted(posted.content, { username: bob.username, url: bobUrl }, ghost);

    const note = async () => {
      const response = await SELF.fetch(
        new URL(`/users/${author.username}/statuses/${posted.id}`, ORIGIN),
        { headers: { accept: "application/activity+json" } },
      );
      return expectContract(ApStatusDocument, await response.json());
    };
    const federated = await note();
    expect(federated.content).toBe(posted.content);
    expect(federated.tag).toEqual([
      { type: "Mention", href: bobUrl, name: `@${bob.username}@example.com` },
      { type: "Hashtag", href: `${ORIGIN}/tags/cat`, name: "#cat" },
    ]);
    expect(federated["@context"]).toContainEqual(
      expect.objectContaining({ Hashtag: "as:Hashtag" }),
    );

    const edited = await send(email, "PUT", `/api/v1/statuses/${posted.id}`, {
      status: text(carol.username),
    });
    expect(edited.mentions).toHaveLength(1);
    const carolUrl = edited.mentions[0]?.url ?? "";
    expect(carolUrl).toBe(`${ORIGIN}/users/${carol.username}`);
    expectFormatted(edited.content, { username: carol.username, url: carolUrl }, ghost);
    expect((await note()).content).toBe(edited.content);
  });
});
