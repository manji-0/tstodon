import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiAccount, ApiOAuthUserinfo } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { accessTokenFor, authHeaders, signedInAccount } from "../test/auth-fixture";

// Mastodon v4.7.5's `OAuth::UserinfoController` and `OAuthUserinfoSerializer`.

const userinfo = async (method: "GET" | "POST", headers: Record<string, string>) => {
  const response = await SELF.fetch("https://example.com/oauth/userinfo", { method, headers });
  return { status: response.status, headers: response.headers, body: await response.json() };
};

describe("/oauth/userinfo", () => {
  it("answers the token's account as OpenID Connect claims, by GET or POST", async () => {
    const email = "userinfo-owner@example.com";
    const renamed = await SELF.fetch("https://example.com/api/v1/accounts/update_credentials", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ display_name: "Info Owner" }),
    });
    expect(renamed.status).toBe(200);
    const account = expectContract(ApiAccount, await renamed.json());
    const headers = await authHeaders(email, { scopes: ["profile"] });

    for (const method of ["GET", "POST"] as const) {
      const answered = await userinfo(method, headers);
      expect(answered.status).toBe(200);
      expect(expectContract(ApiOAuthUserinfo, answered.body)).toEqual({
        iss: "https://example.com/",
        sub: account.uri,
        name: "Info Owner",
        preferred_username: account.username,
        profile: account.url,
        picture: account.avatar,
      });
    }
    expect(account.uri).toBe(`https://example.com/users/${account.username}`);
    expect(account.url).toBe(`https://example.com/@${account.username}`);
  });

  it("takes only the profile scope", async () => {
    const email = "userinfo-scopes@example.com";
    expect((await userinfo("GET", {})).status).toBe(401);
    for (const scopes of [["read"], ["read:accounts"], ["write"]]) {
      const refused = await userinfo("GET", await authHeaders(email, { scopes }));
      expect(refused.status).toBe(403);
    }
    const allowed = await userinfo(
      "GET",
      await authHeaders(email, { scopes: ["read", "profile"] }),
    );
    expect(allowed.status).toBe(200);
  });

  it("refuses an app token, which has no user", async () => {
    const token = await accessTokenFor(undefined, ["profile"]);
    const answered = await userinfo("GET", { Authorization: `Bearer ${token}` });
    // tstodon answers every user-only endpoint an app token reaches with 401.
    expect(answered.status).toBe(401);
    expect(z.object({ error: z.string() }).parse(answered.body).error).toBe(
      "This method requires an authenticated user",
    );
  });

  it("is listed in the authorization server metadata and open to any origin", async () => {
    const metadata = await SELF.fetch("https://example.com/.well-known/oauth-authorization-server");
    expect(
      z.object({ userinfo_endpoint: z.string() }).parse(await metadata.json()).userinfo_endpoint,
    ).toBe("https://example.com/oauth/userinfo");

    await signedInAccount("userinfo-cors@example.com");
    const answered = await userinfo("GET", {
      Origin: "https://client.example",
      ...(await authHeaders("userinfo-cors@example.com", { scopes: ["profile"] })),
    });
    expect(answered.headers.get("access-control-allow-origin")).toBe("*");
  });
});
