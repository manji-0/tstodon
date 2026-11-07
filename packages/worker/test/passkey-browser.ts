import { schemaResult } from "@tstodon/core";
import { SELF } from "cloudflare:test";
import type { z } from "zod";
import { signAccessJwt } from "./access-jwt-fixture";

/**
 * A test browser for pages that require a person: cookies, Origin on writes,
 * and a Cloudflare Access JWT. The account is provisioned from that JWT the
 * way a real Access login is. There is no passkey.
 */

export const ORIGIN = "https://example.com";

/**
 * The test Access key is refused off a local host. Browser pages are fetched
 * here; {@link ORIGIN} stays the instance URL tests compare against.
 */
const REQUEST_ORIGIN = "http://127.0.0.1";

export const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

/**
 * A browser: keeps cookies, sends Origin on writes (unless the request sets
 * its own), attaches the Access assertion when it has one, and does not
 * follow redirects.
 */
export const browser = (assertion?: string) => {
  const cookies = new Map<string, string>();
  let current = assertion;
  const fetcher = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (current) {
      headers.set("Cf-Access-Jwt-Assertion", current);
    }
    if (cookies.size > 0) {
      headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    if (init.method !== undefined && init.method !== "GET" && !headers.has("origin")) {
      headers.set("origin", REQUEST_ORIGIN);
    }
    const response = await SELF.fetch(`${REQUEST_ORIGIN}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value.length === 0 || /max-age=0/i.test(line)) {
        cookies.delete(name);
      } else {
        cookies.set(name, value);
      }
    }
    return response;
  };
  return fetcher;
};

export type Browser = ReturnType<typeof browser>;

export const postJson = (fetcher: Browser, path: string, body: unknown) =>
  fetcher(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const postForm = (fetcher: Browser, path: string, fields: Record<string, string>) =>
  fetcher(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

/**
 * Sign in as `email` (default `<username>@mail.example`). The first page view
 * provisions the account; the username is the address's local part.
 */
export const signUp = async (
  username: string,
  email = `${username}@mail.example`,
): Promise<{ fetcher: Browser; email: string }> => {
  const assertion = await signAccessJwt({ email });
  const fetcher = browser(assertion);
  const page = await fetcher("/auth/sign_in");
  if (page.status !== 200) {
    throw new Error(`sign-in for ${email} returned ${page.status}`);
  }
  return { fetcher, email: email.toLowerCase() };
};
