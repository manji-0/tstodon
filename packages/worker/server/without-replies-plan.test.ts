import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { listActorRemoteStatuses, listPublicRemoteStatuses } from "./remote-status-timeline-store";
import {
  type AccountStatusFilters,
  listAccountStatusesFiltered,
  listPublicStatuses,
} from "./status-timeline-store";

const PlanRow = z.object({ detail: z.string() });

afterEach(() => {
  vi.restoreAllMocks();
});

/** The plan of the first statement `run` sends that reads `table`, with its binds. */
const planOf = async (table: string, run: () => Promise<unknown>): Promise<string[]> => {
  const prepare = env.DB.prepare.bind(env.DB);
  const sent: { sql: string; binds: unknown[] }[] = [];
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...binds) => {
      sent.push({ sql, binds });
      return bind(...binds);
    };
    return statement;
  });
  await run();
  vi.restoreAllMocks();
  const first = sent.find(({ sql }) => new RegExp(`FROM ${table}\\b`).test(sql));
  if (first === undefined) {
    throw new Error(`no statement read ${table}`);
  }
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${first.sql}`)
    .bind(...first.binds)
    .all();
  return z
    .array(PlanRow)
    .parse(results)
    .map((row) => row.detail);
};

const filters: AccountStatusFilters = {
  limit: 20,
  excludeReplies: true,
  excludeReblogs: false,
  excludeDirect: false,
  onlyMedia: false,
};

// `Status.without_replies` reads each row's own columns, so a page still seeks
// its statuses by index: a public timeline walks it in id order and stops at
// the limit, with no sort.
describe("the reply filter's plans", () => {
  it("walks the public local timeline by visibility and id", async () => {
    const details = await planOf("statuses", () => listPublicStatuses(env.DB, "viewer", 20));
    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH statuses USING INDEX idx_statuses_visibility_id \(visibility=\?/,
      ),
    );
    expect(details.filter((detail) => /^SCAN statuses\b|TEMP B-TREE/.test(detail))).toEqual([]);
  });

  it("walks the public remote timeline by visibility and id", async () => {
    const details = await planOf("remote_statuses", () =>
      listPublicRemoteStatuses(env.DB, "viewer", 20, {}, false),
    );
    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH s USING INDEX idx_remote_statuses_visibility_id \(visibility=\?/,
      ),
    );
    expect(details.filter((detail) => /^SCAN s\b|TEMP B-TREE/.test(detail))).toEqual([]);
  });

  it("seeks a local account's statuses by account", async () => {
    const details = await planOf("statuses", () =>
      listAccountStatusesFiltered(env.DB, "1", "viewer", filters),
    );
    expect(details).toContainEqual(
      expect.stringMatching(/^SEARCH statuses USING .*\(account_id=\?/),
    );
    expect(details.filter((detail) => /^SCAN statuses\b/.test(detail))).toEqual([]);
  });

  it("seeks a remote actor's notes by actor", async () => {
    const details = await planOf("remote_statuses", () =>
      listActorRemoteStatuses(env.DB, "https://r.example/users/a", "viewer", filters),
    );
    expect(details).toContainEqual(expect.stringMatching(/^SEARCH s USING .*\(actor_uri=\?/));
    expect(details.filter((detail) => /^SCAN s\b/.test(detail))).toEqual([]);
  });
});
