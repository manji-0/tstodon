import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { remoteActor } from "../test/remote-actor-fixture";
import { ORIGIN, postForm, read, signUp } from "../test/passkey-browser";

const jsonResponse = (body: unknown, type = "application/activity+json"): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": type } });

/** Answer the Worker's own outbound fetches of these URLs; anything else goes out as usual. */
const withFetched = async <T>(
  documents: Readonly<Record<string, unknown>>,
  work: () => Promise<T>,
): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const document = documents[href];
    return document === undefined
      ? original(input as RequestInfo, init)
      : jsonResponse(
          document,
          href.includes("/.well-known/webfinger") ? "application/jrd+json" : undefined,
        );
  }) as typeof fetch;
  try {
    return await work();
  } finally {
    globalThis.fetch = original;
  }
};

const webfinger = (username: string, domain: string, actorUri: string) => ({
  [`https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${username}@${domain}`)}`]:
    {
      subject: `acct:${username}@${domain}`,
      links: [{ rel: "self", type: "application/activity+json", href: actorUri }],
    },
});

const ActorSchema = z.object({ id: z.string(), alsoKnownAs: z.array(z.string()).optional() });

const actor = async (username: string) => {
  const response = await SELF.fetch(`${ORIGIN}/users/${username}`, {
    headers: { Accept: "application/activity+json" },
  });
  expect(response.status).toBe(200);
  return read(ActorSchema, await response.json());
};

describe("moving from a different account", () => {
  it("lists an added alias as alsoKnownAs on the actor, until it is removed", async () => {
    const old = await remoteActor("alias-old", "old.example");
    const { fetcher } = await signUp("alias_new");

    const added = await withFetched(webfinger("alias-old", "old.example", old.actorUri), () =>
      postForm(fetcher, "/settings/aliases", { acct: "@alias-old@old.example" }),
    );
    expect(added.status).toBe(200);
    const page = await added.text();
    expect(page).toContain("alias-old@old.example");
    expect((await actor("alias_new")).alsoKnownAs).toEqual([old.actorUri]);

    const id = /name="id" value="([^"]+)"/.exec(page)?.[1] ?? "";
    const removed = await postForm(fetcher, "/settings/aliases/remove", { id });
    expect(removed.status).toBe(200);
    expect(await removed.text()).toContain("No aliases yet.");
    expect((await actor("alias_new")).alsoKnownAs).toBeUndefined();
  });

  it("refuses a handle that does not resolve, and the account itself", async () => {
    const { fetcher } = await signUp("alias_refused");

    const unknown = await postForm(fetcher, "/settings/aliases", { acct: "nobody" });
    expect(unknown.status).toBe(422);
    expect(await unknown.text()).toContain("No account was found");
    const self = await postForm(fetcher, "/settings/aliases", { acct: "alias_refused" });
    expect(self.status).toBe(422);
    expect((await actor("alias_refused")).alsoKnownAs).toBeUndefined();
  });

  it("needs a signed-in browser on this site", async () => {
    const signedOut = await SELF.fetch(`${ORIGIN}/settings/aliases`, { redirect: "manual" });
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toBe("/auth/sign_in?return_to=%2Fsettings%2Faliases");

    const { fetcher } = await signUp("alias_cross_site");
    const crossSite = await fetcher("/settings/aliases", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
      },
      body: new URLSearchParams({ acct: "alias_refused" }).toString(),
    });
    expect(crossSite.status).toBe(403);
    expect((await actor("alias_cross_site")).alsoKnownAs).toBeUndefined();
  });
});
