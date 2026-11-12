import { DurableObject } from "cloudflare:workers";
import {
  RateLimit,
  type RateLimitCounterState,
  type RateLimitCounterTable,
  type RateLimitIncrement,
} from "@tstodon/domain";

const TABLE_KEY = "counters";

/** How long after its last window ends an idle subject's storage is deleted. */
const SWEEP_DELAY_MS = 60 * 60 * 1000;

/**
 * One rate-limit subject's counters (`RateLimitSubject.key` names the
 * instance: `ip:…`, `account:…`, `token:…`, `domain:…`). A Durable Object is
 * the one place a subject's count is consistent across isolates and
 * locations, which Workers KV (eventually consistent, one write per second
 * per key) and the Rate Limiting binding (10 or 60 second windows, counted
 * per location, no remaining count) are not, and it keeps D1 off the hot path.
 * Isolates count most requests alone and call here only now and then (see
 * `RateLimit.mayCountLocally`).
 *
 * The table (a few counters) is kept in memory and written back on every
 * hit, so an evicted instance resumes where it was. Windows that ended are
 * dropped on the next hit. One alarm, an hour after the last window ends,
 * deletes the storage of a subject whose windows have all ended, or re-arms
 * when hits came since, so subjects seen once leave nothing behind; each
 * alarm is a billed request, so a pending alarm is never moved per window.
 */
export class RateLimitCounter extends DurableObject<Env> {
  private table: RateLimitCounterTable | undefined;
  private alarmSet = false;

  private async load(): Promise<RateLimitCounterTable> {
    if (this.table === undefined) {
      const parsed = RateLimit.parseTable(this.ctx.storage.kv.get(TABLE_KEY) ?? {});
      this.table = parsed.isOk() ? parsed.value : {};
      this.alarmSet = (await this.ctx.storage.getAlarm()) !== null;
    }
    return this.table;
  }

  /** Count `hits` at `nowMs` (the caller's clock) and return each counter's state. */
  async hit(
    hits: ReadonlyArray<RateLimitIncrement>,
    nowMs: number,
  ): Promise<ReadonlyArray<RateLimitCounterState>> {
    const { table, states } = RateLimit.count(await this.load(), hits, nowMs);
    this.table = table;
    this.ctx.storage.kv.put(TABLE_KEY, table);
    if (!this.alarmSet) {
      await this.sweepAfter(table);
    }
    return states;
  }

  /** Delete the storage once every window has ended; check again later otherwise. */
  override async alarm(): Promise<void> {
    this.alarmSet = false;
    const { table } = RateLimit.count(await this.load(), [], Date.now());
    this.table = table;
    if (RateLimit.expiresAtMs(table) === undefined) {
      await this.ctx.storage.deleteAll();
      return;
    }
    this.ctx.storage.kv.put(TABLE_KEY, table);
    await this.sweepAfter(table);
  }

  private async sweepAfter(table: RateLimitCounterTable): Promise<void> {
    const expiresAtMs = RateLimit.expiresAtMs(table) ?? Date.now();
    this.alarmSet = true;
    await this.ctx.storage.setAlarm(expiresAtMs + SWEEP_DELAY_MS);
  }
}
