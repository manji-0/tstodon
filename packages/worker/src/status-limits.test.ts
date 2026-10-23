import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";

const auth = (email: string): Promise<Record<string, string>> => authHeaders(email);

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const expectKind = (response: { status: number; body: unknown }, kind: string): void => {
  expect(response.status).toBe(422);
  expect(read(z.object({ kind: z.string() }), response.body).kind).toBe(kind);
};

const createStatus = async (
  email: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(payload),
  });

describe("status limits", () => {
  it("rejects text and content warnings over 500 characters", async () => {
    const email = "limits-text@example.com";
    const tooLong = await createStatus(email, { status: "a".repeat(501) });
    expectKind(tooLong, "TooLong");

    const atLimit = await createStatus(email, { status: "b".repeat(500) });
    expect(atLimit.status).toBe(200);

    const cw = await createStatus(email, {
      status: "with a long cw",
      spoiler_text: "c".repeat(501),
    });
    expectKind(cw, "TooLong");
  });

  it("bounds poll option count, option length, and expiry", async () => {
    const email = "limits-poll@example.com";
    const oneOption = await createStatus(email, { status: "poll", poll: { options: ["only"] } });
    expect(oneOption.status).toBe(422);

    const fiveOptions = await createStatus(email, {
      status: "poll",
      poll: { options: ["a", "b", "c", "d", "e"] },
    });
    expect(fiveOptions.status).toBe(422);

    const longOption = await createStatus(email, {
      status: "poll",
      poll: { options: ["ok", "x".repeat(51)] },
    });
    expect(longOption.status).toBe(422);

    const created = await createStatus(email, {
      status: "poll",
      poll: { options: ["yes", "no"], expires_in: 1 },
    });
    expect(created.status).toBe(200);
    const poll = read(
      z.object({ poll: z.object({ expires_at: z.string().min(1) }) }),
      created.body,
    ).poll;
    const remainingMs = Date.parse(poll.expires_at) - Date.now();
    // Clamped up to the advertised 300-second minimum.
    expect(remainingMs).toBeGreaterThan(295_000);
    expect(remainingMs).toBeLessThan(305_000);
  });

  it("rejects an over-long media description", async () => {
    const email = "limits-media@example.com";
    const form = new FormData();
    form.set("file", new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
    const uploaded = await json("/api/v2/media", {
      method: "POST",
      headers: await auth(email),
      body: form,
    });
    const mediaId = read(z.object({ id: z.string().min(1) }), uploaded.body).id;

    const update = new FormData();
    update.set("description", "d".repeat(1501));
    const updated = await json(`/api/v1/media/${mediaId}`, {
      method: "PUT",
      headers: await auth(email),
      body: update,
    });
    expect(updated.status).toBe(422);
  });

  it("advertises the enforced limits on /api/v2/instance", async () => {
    const response = await json("/api/v2/instance");
    expect(response.status).toBe(200);
    const instance = read(
      z.object({
        configuration: z.object({
          accounts: z.object({
            max_featured_tags: z.number(),
            max_pinned_statuses: z.number(),
          }),
          statuses: z.object({
            max_characters: z.number(),
            max_media_attachments: z.number(),
          }),
          polls: z.object({ max_options: z.number(), min_expiration: z.number() }),
          media_attachments: z.object({ description_limit: z.number() }),
          translation: z.object({ enabled: z.boolean() }),
          limited_federation: z.boolean(),
          urls: z.object({
            streaming: z.string().min(1),
            about: z.string().nullable(),
            privacy_policy: z.string().nullable(),
            terms_of_service: z.string().nullable(),
          }),
        }),
        thumbnail: z.object({ url: z.string().min(1), description: z.string().optional() }),
        registrations: z.object({
          enabled: z.boolean(),
          approval_required: z.boolean(),
          reason_required: z.boolean(),
          min_age: z.number(),
          url: z.string().nullable(),
        }),
      }),
      response.body,
    );
    expect(instance.configuration.statuses.max_characters).toBe(500);
    expect(instance.configuration.statuses.max_media_attachments).toBe(4);
    expect(instance.configuration.accounts.max_pinned_statuses).toBe(5);
    expect(instance.configuration.accounts.max_featured_tags).toBe(10);
    expect(instance.configuration.polls.max_options).toBe(4);
    expect(instance.configuration.polls.min_expiration).toBe(300);
    expect(instance.configuration.media_attachments.description_limit).toBe(1500);
    expect(instance.configuration.translation.enabled).toBe(false);
    expect(instance.configuration.limited_federation).toBe(false);
    // Policy documents are configured in the test environment, so their URLs are published.
    expect(instance.configuration.urls.privacy_policy).toContain("/privacy-policy");
    expect(instance.configuration.urls.terms_of_service).toContain("/terms-of-service");
    expect(instance.configuration.urls.streaming.startsWith("wss://")).toBe(true);
    expect(instance.thumbnail.description).toBe("tstodon instance thumbnail");
    expect(instance.registrations.min_age).toBe(16);
    expect(instance.registrations.reason_required).toBe(false);
  });
});
