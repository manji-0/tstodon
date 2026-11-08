import type { RepositoryError, ThreadStatus } from "@tstodon/domain";
import { err, ok } from "neverthrow";
import { describe, expect, it } from "vite-plus/test";
import { testLocalNote } from "../test/domain-fixture";
import { listThreadAncestors } from "./thread-context";

const node = (id: string): ThreadStatus => ({ kind: "Local", status: testLocalNote(id) });

/** A thread given as child id -> parent id. */
const parents = (edges: Readonly<Record<string, string>>) => async (status: ThreadStatus) => {
  const parent = edges[status.status.id];
  return ok(parent === undefined ? undefined : node(parent));
};

const ids = (chain: ReadonlyArray<ThreadStatus>) => chain.map((status) => status.status.id);

describe("listThreadAncestors", () => {
  it("lists the statuses above one, oldest first", async () => {
    const chain = await listThreadAncestors(
      parents({ "4": "3", "3": "2", "2": "1" }),
      node("4"),
      40,
    );
    expect(chain.map(ids).unwrapOr([])).toEqual(["1", "2", "3"]);
  });

  it("stops at the depth limit, keeping the nearest parents", async () => {
    const chain = await listThreadAncestors(
      parents({ "4": "3", "3": "2", "2": "1" }),
      node("4"),
      2,
    );
    expect(chain.map(ids).unwrapOr([])).toEqual(["2", "3"]);
  });

  it("ends a forged reply loop at the first status seen twice", async () => {
    const chain = await listThreadAncestors(
      parents({ "3": "2", "2": "1", "1": "3" }),
      node("3"),
      40,
    );
    expect(chain.map(ids).unwrapOr([])).toEqual(["1", "2"]);
  });

  it("returns the lookup failure", async () => {
    const failure: RepositoryError = { kind: "RepositoryError", message: "down" };
    const chain = await listThreadAncestors(async () => err(failure), node("2"), 40);
    expect(chain.isErr() ? chain.error : undefined).toEqual(failure);
  });
});
