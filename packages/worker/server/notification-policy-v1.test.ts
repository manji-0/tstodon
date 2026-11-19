import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { ApiAccount, ApiNotificationPolicy, ApiNotificationPolicyV1 } from "@tstodon/api";
import { authHeaders } from "../test/auth-fixture";
import { expectContract } from "../test/api-contract";

// Mastodon v4.7.5's `Api::V1::Notifications::PoliciesController`: the same
// policy as v2, read and written as `filter_*` booleans.

const send = async (
  email: string | undefined,
  method: string,
  path: string,
  body?: BodyInit,
  options?: Readonly<{ scopes?: ReadonlyArray<string>; contentType?: string }>,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": options?.contentType ?? "application/json" }),
      ...(email === undefined ? {} : await authHeaders(email, { scopes: options?.scopes })),
    },
    ...(body === undefined ? {} : { body }),
  });
  return { status: response.status, body: await response.json() };
};

const v1 = async (email: string) => {
  const response = await send(email, "GET", "/api/v1/notifications/policy");
  expect(response.status).toBe(200);
  return expectContract(ApiNotificationPolicyV1, response.body);
};

const v2 = async (email: string) => {
  const response = await send(email, "GET", "/api/v2/notifications/policy");
  expect(response.status).toBe(200);
  return expectContract(ApiNotificationPolicy, response.body);
};

const update = async (method: "PUT" | "PATCH", email: string, body: Record<string, unknown>) => {
  const response = await send(email, method, "/api/v1/notifications/policy", JSON.stringify(body));
  expect(response.status).toBe(200);
  return expectContract(ApiNotificationPolicyV1, response.body);
};

describe("GET /api/v1/notifications/policy", () => {
  it("renders Mastodon's defaults and the pending requests as filter_* booleans", async () => {
    const email = "policy-v1-owner@example.com";
    expect(await v1(email)).toEqual({
      filter_not_following: false,
      filter_not_followers: false,
      filter_new_accounts: false,
      filter_private_mentions: true,
      filter_bots: false,
      summary: { pending_requests_count: 0, pending_notifications_count: 0 },
    });

    const recipient = await send(email, "GET", "/api/v1/accounts/verify_credentials");
    const username = expectContract(ApiAccount, recipient.body).username;
    const mention = await send(
      "policy-v1-stranger@example.com",
      "POST",
      "/api/v1/statuses",
      JSON.stringify({ status: `@${username} psst`, visibility: "direct" }),
    );
    expect(mention.status).toBe(200);
    expect((await v1(email)).summary).toEqual({
      pending_requests_count: 1,
      pending_notifications_count: 1,
    });
  });

  it("reads a drop as filtered", async () => {
    const email = "policy-v1-drop@example.com";
    const dropped = await send(
      email,
      "PATCH",
      "/api/v2/notifications/policy",
      JSON.stringify({ for_new_accounts: "drop" }),
    );
    expect(dropped.status).toBe(200);
    expect((await v1(email)).filter_new_accounts).toBe(true);
  });

  it("needs a user token with read:notifications", async () => {
    expect((await send(undefined, "GET", "/api/v1/notifications/policy")).status).toBe(401);
    const scoped = await send("policy-v1-scope@example.com", "GET", "/api/v1/notifications/policy");
    expect(scoped.status).toBe(200);
    const wrong = await send(
      "policy-v1-scope@example.com",
      "GET",
      "/api/v1/notifications/policy",
      undefined,
      { scopes: ["read:statuses"] },
    );
    expect(wrong.status).toBe(403);
  });
});

describe("PUT /api/v1/notifications/policy", () => {
  it("sets each named for_* to filter or accept and keeps the others", async () => {
    const email = "policy-v1-put@example.com";
    await send(
      email,
      "PATCH",
      "/api/v2/notifications/policy",
      JSON.stringify({ for_new_accounts: "drop", for_limited_accounts: "drop" }),
    );

    const updated = await update("PUT", email, {
      filter_not_following: true,
      filter_private_mentions: false,
    });
    expect(updated).toMatchObject({
      filter_not_following: true,
      filter_private_mentions: false,
      filter_new_accounts: true,
    });
    expect(await v2(email)).toMatchObject({
      for_not_following: "filter",
      for_not_followers: "accept",
      for_new_accounts: "drop",
      for_private_mentions: "accept",
      for_limited_accounts: "drop",
      for_bots: "accept",
    });

    await update("PATCH", email, { filter_bots: true, filter_new_accounts: null });
    expect(await v2(email)).toMatchObject({ for_bots: "filter", for_new_accounts: "accept" });
  });

  it("takes a form body", async () => {
    const email = "policy-v1-form@example.com";
    const response = await send(
      email,
      "PUT",
      "/api/v1/notifications/policy",
      "filter_not_followers=true",
      { contentType: "application/x-www-form-urlencoded" },
    );
    expect(response.status).toBe(200);
    expect(expectContract(ApiNotificationPolicyV1, response.body).filter_not_followers).toBe(true);
    expect((await v2(email)).for_not_followers).toBe("filter");
  });

  it("needs write:notifications", async () => {
    const email = "policy-v1-put-scope@example.com";
    const body = JSON.stringify({ filter_bots: true });
    expect((await send(undefined, "PUT", "/api/v1/notifications/policy", body)).status).toBe(401);
    const readOnly = await send(email, "PUT", "/api/v1/notifications/policy", body, {
      scopes: ["read:notifications"],
    });
    expect(readOnly.status).toBe(403);
    expect((await v2(email)).for_bots).toBe("accept");
  });
});
