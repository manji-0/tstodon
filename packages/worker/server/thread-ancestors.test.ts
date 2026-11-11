import { SELF, env } from "cloudflare:test";
import type { RepositoryError, ThreadStatus } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { authHeaders } from "../test/auth-fixture";
import { parseInstanceIdentity } from "./runtime-config";
import { findStatusById } from "./status-store";
import { listThreadAncestors } from "./thread-context";

const identity = () => {
  const parsed = parseInstanceIdentity(env);
  if (parsed.isErr()) {
    throw new Error("no instance identity");
  }
  return parsed.value;
};

/** Post a public chain of `length` replies and return its ids, root first. */
const chain = async (email: string, length: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const response = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({
        status: `chain ${index}`,
        visibility: "public",
        ...(ids.length > 0 ? { in_reply_to_id: ids.at(-1) } : {}),
      }),
    });
    expect(response.status).toBe(200);
    const { id } = await response.json<{ id: string }>();
    ids.push(id);
  }
  return ids;
};

const node = async (id: string): Promise<ThreadStatus> => {
  const status = await findStatusById(env.DB, id);
  if (status.isErr() || !status.value) {
    throw new Error(`no status ${id}`);
  }
  return { kind: "Local", status: status.value };
};

const ancestorIds = async (db: D1Database, start: ThreadStatus, depth: number) =>
  (await listThreadAncestors(db, identity(), start, depth)).map((statuses) =>
    statuses.map((status) => status.status.id),
  );

describe("listThreadAncestors", () => {
  it("lists the statuses above one, oldest first", async () => {
    const ids = await chain("thread-ancestors-order@example.com", 4);
    const leaf = await node(ids[3] ?? "");
    expect((await ancestorIds(env.DB, leaf, 40)).unwrapOr([])).toEqual(ids.slice(0, 3));
  });

  it("stops at the depth limit, keeping the nearest parents", async () => {
    const ids = await chain("thread-ancestors-depth@example.com", 4);
    const leaf = await node(ids[3] ?? "");
    expect((await ancestorIds(env.DB, leaf, 2)).unwrapOr([])).toEqual(ids.slice(1, 3));
  });

  it("walks a chain deeper than one step at a time would reach cheaply", async () => {
    const ids = await chain("thread-ancestors-deep@example.com", 50);
    const leaf = await node(ids[49] ?? "");
    expect((await ancestorIds(env.DB, leaf, 4096)).unwrapOr([])).toEqual(ids.slice(0, 49));
    expect((await ancestorIds(env.DB, leaf, 20)).unwrapOr([])).toEqual(ids.slice(29, 49));
  });

  it("returns the lookup failure", async () => {
    const ids = await chain("thread-ancestors-failure@example.com", 2);
    const leaf = await node(ids[1] ?? "");
    const failing = new Proxy(env.DB, {
      get: (target, property) =>
        property === "prepare"
          ? () => {
              throw new Error("down");
            }
          : Reflect.get(target, property),
    });
    const result = await ancestorIds(failing, leaf, 40);
    const failure: RepositoryError | undefined = result.isErr() ? result.error : undefined;
    expect(failure?.kind).toBe("RepositoryError");
  });
});
