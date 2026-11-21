import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { findStatusById } from "./status-store";
import { parseInstanceIdentity } from "./runtime-config";
import { listThreadDescendants } from "./thread-context";

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
  // Posting a 22-deep chain one reply at a time takes 5-13 s alone and longer
  // under the full suite, past the 15 s default.
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

    // Anonymous: 40 ancestors, and descendants 20 deep.
    const anonymousDeep = await contextAt(deepest ?? "");
    expect(anonymousDeep.ancestors.map((status) => status.id)).toEqual(chain.slice(0, 22));
    const anonymousRoot = await contextAt(root ?? "");
    expect(anonymousRoot.descendants).toHaveLength(20);

    // Authenticated: the whole chain.
    const authenticatedDeep = await contextAt(deepest ?? "", email);
    expect(authenticatedDeep.ancestors).toHaveLength(22);
    expect(authenticatedDeep.ancestors.map((status) => status.id)).toEqual(chain.slice(0, 22));

    const authenticatedRoot = await contextAt(root ?? "", email);
    expect(authenticatedRoot.descendants).toHaveLength(22);
    expect(authenticatedRoot.descendants.map((status) => status.id)).toEqual(chain.slice(1));
  }, 60_000);
});

describe("status context descendants", () => {
  it("come depth first, each reply's subtree before its next sibling", async () => {
    const root = await postStatus("dfs-root@example.com", { status: "dfs root" });
    const first = await postStatus("dfs-first@example.com", {
      status: "dfs first",
      in_reply_to_id: root,
    });
    const second = await postStatus("dfs-second@example.com", {
      status: "dfs second",
      in_reply_to_id: root,
    });
    const nested = await postStatus("dfs-second@example.com", {
      status: "dfs nested",
      in_reply_to_id: first,
    });

    const context = await contextAt(root);

    expect(context.descendants.map((status) => status.id)).toEqual([first, nested, second]);
  }, 30_000);

  it("are limited in depth-first order, as Mastodon's ORDER BY path LIMIT", async () => {
    const root = await postStatus("dfs-limit-root@example.com", { status: "limit root" });
    const first = await postStatus("dfs-limit-first@example.com", {
      status: "limit first",
      in_reply_to_id: root,
    });
    await postStatus("dfs-limit-second@example.com", {
      status: "limit second",
      in_reply_to_id: root,
    });
    const nested = await postStatus("dfs-limit-second@example.com", {
      status: "limit nested",
      in_reply_to_id: first,
    });
    const start = (await findStatusById(env.DB, root))._unsafeUnwrap();
    if (!start) {
      throw new Error("root not stored");
    }

    const limited = await listThreadDescendants(
      env.DB,
      parseInstanceIdentity(env)._unsafeUnwrap(),
      { kind: "Local", status: start },
      2,
      20,
    );

    expect(limited._unsafeUnwrap().map((reply) => reply.node.status.id)).toEqual([first, nested]);
  }, 30_000);

  it("bring replies to their own author's status to the top, keeping their order", async () => {
    const author = "promote-author@example.com";
    const root = await postStatus(author, { status: "promote root" });
    const other = await postStatus("promote-other@example.com", {
      status: "promote other",
      in_reply_to_id: root,
    });
    const self = await postStatus(author, { status: "promote self", in_reply_to_id: root });
    const selfNested = await postStatus(author, {
      status: "promote self nested",
      in_reply_to_id: self,
    });

    const context = await contextAt(root);

    expect(context.descendants.map((status) => status.id)).toEqual([self, selfNested, other]);
  }, 30_000);
});
