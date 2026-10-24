import { schemaResult } from "@tstodon/core";
import { env, SELF } from "cloudflare:test";
import { expect } from "vite-plus/test";
import { z } from "zod";
import { mailboxKey } from "../src/mailer";
import { softPasskey, type SoftPasskey } from "./soft-passkey";

/**
 * A test browser for the sign-up and sign-in pages: cookies, Origin on
 * writes, captured confirmation mail, and a software passkey.
 */

export const ORIGIN = "https://example.com";

export const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

/** A browser: keeps cookies, sends Origin on writes, does not follow redirects. */
export const browser = () => {
  const cookies = new Map<string, string>();
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookies.size > 0) {
      headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    if (init.method !== undefined && init.method !== "GET") {
      headers.set("origin", ORIGIN);
    }
    const response = await SELF.fetch(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
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

const RegistrationOptionsSchema = z.object({
  challenge: z.string(),
  rp: z.object({ id: z.string().optional() }),
});

const MailSchema = z.object({ to: z.string(), subject: z.string(), text: z.string() });

/** Step one: submit the form; the captured email's link token. */
export const requestSignupLink = async (
  fetcher: Browser,
  username: string,
  email: string,
): Promise<string> => {
  const sent = await postForm(fetcher, "/auth/sign_up", { username, email });
  expect(sent.status).toBe(200);
  expect(await sent.text()).toContain("Check your email");
  const mail = read(MailSchema, JSON.parse((await env.APP_CACHE.get(mailboxKey(email))) ?? "null"));
  const link = /https:\/\/example\.com\/auth\/sign_up\/verify\?token=([\w-]+)/.exec(mail.text);
  expect(link).not.toBeNull();
  return link?.[1] ?? "";
};

export const registrationOptions = (fetcher: Browser, context: string) =>
  fetcher(
    `/api/auth/passkey/generate-register-options?${new URLSearchParams({ context }).toString()}`,
  );

export const signUp = async (
  username: string,
  email = `${username}@mail.example`,
): Promise<{ fetcher: Browser; passkey: SoftPasskey; token: string }> => {
  const fetcher = browser();
  const token = await requestSignupLink(fetcher, username, email);
  const page = await fetcher(`/auth/sign_up/verify?${new URLSearchParams({ token }).toString()}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain(`@${username}`);
  const options = await registrationOptions(fetcher, token);
  expect(options.status).toBe(200);
  const passkey = await softPasskey(ORIGIN);
  const response = await passkey.register(read(RegistrationOptionsSchema, await options.json()));
  const verified = await postJson(fetcher, "/api/auth/passkey/verify-registration", {
    response,
    createSession: true,
  });
  expect(verified.status).toBe(200);
  return { fetcher, passkey, token };
};
