import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult, InstanceLimits } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";

const auth = (email: string): Promise<Record<string, string>> => accessAuthHeaders(email);

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

const upload = async (
  email: string,
  type: string,
  name: string,
): Promise<{ status: number; body: unknown }> => {
  const form = new FormData();
  form.set("file", new File([new Uint8Array([1, 2, 3])], name, { type }));
  return json("/api/v2/media", {
    method: "POST",
    headers: await auth(email),
    body: form,
  });
};

describe("media mime validation", () => {
  it("accepts the advertised types and rejects others", async () => {
    const email = "mime-owner@example.com";

    for (const type of InstanceLimits.media.supportedMimeTypes) {
      const response = await upload(email, type, `file-${type.replace("/", "-")}`);
      expect(response.status).toBe(200);
    }

    const rejected = await upload(email, "text/plain", "notes.txt");
    expect(rejected.status).toBe(422);
    expect(read(z.object({ kind: z.string() }), rejected.body).kind).toBe("UnsupportedMediaType");

    // A type the instance never advertises is refused too.
    expect((await upload(email, "application/zip", "archive.zip")).status).toBe(422);
  });

  it("advertises exactly the accepted types", async () => {
    const response = await json("/api/v2/instance");
    const configuration = read(
      z.object({
        configuration: z.object({
          media_attachments: z.object({ supported_mime_types: z.array(z.string().min(1)) }),
        }),
      }),
      response.body,
    ).configuration.media_attachments;
    expect(configuration.supported_mime_types).toEqual([
      ...InstanceLimits.media.supportedMimeTypes,
    ]);
  });
});
