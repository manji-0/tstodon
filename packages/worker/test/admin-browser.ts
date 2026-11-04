import { env, SELF } from "cloudflare:test";
import { expect } from "vite-plus/test";
import { z } from "zod";
import { authHeaders } from "./auth-fixture";
import { type Browser, ORIGIN, read, signUp } from "./passkey-browser";

/** Helpers for the tests of the server-rendered admin pages. */

export const IdSchema = z.object({ id: z.string().min(1) });

/** The page's HTML, after checking its status and that it is a page. */
export const page = async (response: Response, status = 200): Promise<string> => {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
};

export const redirectsTo = (response: Response, location: string) => {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(location);
};

/** A JSON API call that must answer 200. */
export const api = async (
  path: string,
  headers: Record<string, string>,
  init: RequestInit = {},
) => {
  const response = await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
  expect(response.status, path).toBe(200);
  return response.json();
};

/** A signed-in browser whose Better Auth user has the admin role. */
export const adminBrowser = async (username: string): Promise<{ fetcher: Browser; id: string }> => {
  const { fetcher } = await signUp(username);
  await env.DB.prepare(
    `UPDATE "user" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE username = ?)`,
  )
    .bind(username)
    .run();
  const lookup = await SELF.fetch(`${ORIGIN}/api/v1/accounts/lookup?acct=${username}`);
  return { fetcher, id: read(IdSchema, await lookup.json()).id };
};

/** The API credentials and account id of the account behind `email`. */
export const accountOf = async (email: string) => {
  const headers = await authHeaders(email);
  return {
    headers,
    id: read(IdSchema, await api("/api/v1/accounts/verify_credentials", headers)).id,
  };
};

/** Credentials for the admin API. */
export const adminApi = (email = "pages-api-admin@example.com") =>
  authHeaders(email, { admin: true });
