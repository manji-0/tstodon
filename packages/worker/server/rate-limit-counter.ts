import { DurableObject } from "cloudflare:workers";
import {
  RateLimit,
  type RateLimitCounterState,
  type RateLimitCounterTable,
  type RateLimitHit,
} from "@tstodon/domain";

const TABLE_KEY = "counters";

/**
 * One rate-limit subject's counters (`RateLimitSubject.key` names the
 * instance: `ip:…`, `account:…`, `token:…`, `domain:…`). A Durable Object is
 * the one place a subject's count is consistent across isolates and
 * locations, which Workers KV (eventually consistent, one write per second
 * per key) and the Rate Limiting binding (10 or 60 second windows, counted
 * per location, no remaining count) are not, and it keeps D1 off the hot path.
 *
 * The table (a few counters) is kept in memory and written back on every
 * hit, so an evicted instance resumes where it was; an alarm at the last
 * window's end deletes it, so subjects seen once leave nothing behind.
 */
export class RateLimitCounter extends DurableObject<Env> {
  private table: RateLimitCounterTable | undefined;
  private alarmAtMs: number | undefined;

  private load(): RateLimitCounterTable {
    if (this.table === undefined) {
      const parsed = RateLimit.parseTable(this.ctx.storage.kv.get(TABLE_KEY) ?? {});
      this.table = parsed.isOk() ? parsed.value : {};
    }
    return this.table;
  }

  private async save(table: RateLimitCounterTable): Promise<void> {
    this.table = table;
    const expiresAtMs = RateLimit.expiresAtMs(table);
    if (expiresAtMs === undefined) {
      this.alarmAtMs = undefined;
      await this.ctx.storage.deleteAll();
      return;
    }
    this.ctx.storage.kv.put(TABLE_KEY, table);
    if (this.alarmAtMs === undefined || expiresAtMs > this.alarmAtMs) {
      this.alarmAtMs = expiresAtMs;
      await this.ctx.storage.setAlarm(expiresAtMs);
    }
  }

  /** Count `hits` at `nowMs` (the caller's clock) and return each counter's state. */
  async hit(
    hits: ReadonlyArray<RateLimitHit>,
    nowMs: number,
  ): Promise<ReadonlyArray<RateLimitCounterState>> {
    const { table, states } = RateLimit.count(this.load(), hits, nowMs);
    await this.save(table);
    return states;
  }

  /** Drop the windows that have ended; the instance's storage goes with the last. */
  override async alarm(): Promise<void> {
    this.alarmAtMs = undefined;
    await this.save(RateLimit.count(this.load(), [], Date.now()).table);
  }
}
