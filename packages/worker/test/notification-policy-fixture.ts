import { SELF } from "cloudflare:test";
import { expect } from "vite-plus/test";
import { authHeaders } from "./auth-fixture";

/**
 * Let `email`'s account take private mentions from anyone. Mastodon's default
 * policy holds a stranger's direct message as a notification request, and the
 * message joins the account's conversations only once the request is accepted.
 */
export const acceptPrivateMentions = async (email: string): Promise<void> => {
  const response = await SELF.fetch("https://example.com/api/v2/notifications/policy", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ for_private_mentions: "accept" }),
  });
  expect(response.status).toBe(200);
};
