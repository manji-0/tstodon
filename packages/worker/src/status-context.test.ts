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

const ContextSchema = z.object({
  ancestors: z.array(z.object({ id: z.string().min(1) })),
  descendants: z.array(z.object({ id: z.string().min(1) })),
});

const postStatus = async (email: string, payload: Record<string, unknown>): Promise<string> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return read(z.object({ id: z.string().min(1) }), response.body).id;
};

const contextAt = async (
  statusId: string,
  email?: string,
): Promise<z.infer<typeof ContextSchema>> => {
  const response = await json(
    `/api/v1/statuses/${statusId}/context`,
    email ? { headers: await auth(email) } : undefined,
  );
  expect(response.status).toBe(200);
  return read(ContextSchema, response.body);
};

describe("status context", () => {
  it("bounds anonymous contexts and lifts the bounds for a signed-in viewer", async () => {
    const email = "context-author@example.com";
    // A 22-deep chain: root plus 22 replies.
    const chain = [await postStatus(email, { status: "context root" })];
    for (let depth = 1; depth <= 22; depth += 1) {
      chain.push(
        await postStatus(email, {
          status: `context reply ${depth}`,
          in_reply_to_id: chain[depth - 1],
        }),
      );
    }
    const root = chain[0];
    const deepest = chain[22];
    expect(root).toBeDefined();
    expect(deepest).toBeDefined();

    // Anonymous: depth capped at 20.
    const anonymousDeep = await contextAt(deepest ?? "");
    expect(anonymousDeep.ancestors).toHaveLength(20);
    expect(anonymousDeep.ancestors.map((status) => status.id)).not.toContain(root);
    const anonymousRoot = await contextAt(root ?? "");
    expect(anonymousRoot.descendants).toHaveLength(20);

    // Authenticated: the whole chain.
    const authenticatedDeep = await contextAt(deepest ?? "", email);
    expect(authenticatedDeep.ancestors).toHaveLength(22);
    expect(authenticatedDeep.ancestors.map((status) => status.id)).toEqual(chain.slice(0, 22));

    const authenticatedRoot = await contextAt(root ?? "", email);
    expect(authenticatedRoot.descendants).toHaveLength(22);
    // Descendants come back in chronological (id) order.
    expect(authenticatedRoot.descendants.map((status) => status.id)).toEqual(chain.slice(1));
  });
});
