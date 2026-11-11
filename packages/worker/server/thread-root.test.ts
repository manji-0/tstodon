import { SELF, env } from "cloudflare:test";
import type { LocalStatus } from "@tstodon/domain";
import { describe, expect, it } from "vite-plus/test";
import { authHeaders } from "../test/auth-fixture";
import { testLocalNote } from "../test/domain-fixture";
import { resolveThreadRootStatusIds } from "./status-mute-store";
import { findStatusesByIds } from "./status-store";

/** Post a public chain of `length` replies and return its ids, root first. */
const chain = async (email: string, length: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const response = await SELF.fetch("https://example.com/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({
        status: `thread root ${index}`,
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

const statuses = async (ids: ReadonlyArray<string>): Promise<LocalStatus[]> => {
  const found = await findStatusesByIds(env.DB, ids);
  if (found.isErr()) {
    throw new Error("statuses not found");
  }
  return ids.flatMap((id) => {
    const status = found.value.get(id);
    return status ? [status] : [];
  });
};

const roots = async (given: ReadonlyArray<LocalStatus>) => {
  const resolved = await resolveThreadRootStatusIds(env.DB, given);
  if (resolved.isErr()) {
    throw new Error("roots not resolved");
  }
  return resolved.value;
};

describe("resolveThreadRootStatusIds", () => {
  it("finds the root of a chain within 20 parents", async () => {
    const ids = await chain("thread-root-short@example.com", 21);
    expect((await roots(await statuses([ids[20] ?? ""]))).get(ids[20] ?? "")).toBe(ids[0]);
  });

  it("ends a deeper chain at the first parent past the limit", async () => {
    const ids = await chain("thread-root-deep@example.com", 25);
    // 20 parents are loaded; the 21st is named by the 20th but not loaded.
    expect((await roots(await statuses([ids[24] ?? ""]))).get(ids[24] ?? "")).toBe(ids[3]);
  });

  it("counts the limit from the nearest given status", async () => {
    const ids = await chain("thread-root-shared@example.com", 31);
    const resolved = await roots(await statuses([ids[30] ?? "", ids[10] ?? ""]));
    expect(resolved.get(ids[30] ?? "")).toBe(ids[0]);
    expect(resolved.get(ids[10] ?? "")).toBe(ids[0]);
  });

  it("ends at a parent that is not stored", async () => {
    const resolved = await roots([testLocalNote("thread-root-orphan", "thread-root-missing")]);
    expect(resolved.get("thread-root-orphan")).toBe("thread-root-missing");
  });
});
