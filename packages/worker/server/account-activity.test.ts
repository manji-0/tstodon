import { env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { signedInAccount } from "../test/auth-fixture";
import { parseRows } from "./d1";
import { recordAccountActivity, signedInRecentlySince } from "./account-activity";

// Mastodon's `UserTrackingConcern` moves `current_sign_in_at` to the request's
// time when it is unset or older than `SIGN_IN_UPDATE_FREQUENCY` (24 hours),
// and a sign-in (`update_sign_in!(new_sign_in: true)`) moves it to the
// sign-in's time. `User.signed_in_recently` compares it with
// `USER_ACTIVE_DAYS` before now.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const api = new Request("https://example.com/api/v1/timelines/home");

const signInOf = async (accountId: string): Promise<string | null> => {
  const [row] = parseRows(
    z.object({ current_sign_in_at: z.string().nullable() }),
    (
      await env.DB.prepare("SELECT current_sign_in_at FROM accounts WHERE id = ?")
        .bind(accountId)
        .all()
    ).results,
  );
  return row?.current_sign_in_at ?? null;
};

describe("the sign-in time an authenticated request records", () => {
  it("moves to the request's time at most once a day", async () => {
    const account = await signedInAccount("aa-daily@example.com");
    const first = new Date("2026-03-01T22:00:00.000Z");

    await recordAccountActivity(env.DB, account.id, api, first);
    expect(await signInOf(account.id)).toBe(first.toISOString());

    // The next UTC day, but inside 24 hours: unchanged.
    await recordAccountActivity(env.DB, account.id, api, new Date(first.getTime() + 23 * HOUR_MS));
    expect(await signInOf(account.id)).toBe(first.toISOString());

    // Still the same UTC day as the request above, but past 24 hours.
    const later = new Date(first.getTime() + 25 * HOUR_MS);
    await recordAccountActivity(env.DB, account.id, api, later);
    expect(await signInOf(account.id)).toBe(later.toISOString());
  });

  it("moves to a fresh sign-in's time", async () => {
    const account = await signedInAccount("aa-login@example.com");
    const first = new Date("2026-03-01T08:00:00.000Z");
    await recordAccountActivity(env.DB, account.id, api, first);

    const login = new Date(first.getTime() + 2 * HOUR_MS);
    await recordAccountActivity(env.DB, account.id, api, new Date(login.getTime() + 60_000), login);
    expect(await signInOf(account.id)).toBe(login.toISOString());

    // The same sign-in on a later request moves nothing.
    await recordAccountActivity(
      env.DB,
      account.id,
      api,
      new Date(login.getTime() + HOUR_MS),
      login,
    );
    expect(await signInOf(account.id)).toBe(login.toISOString());
  });

  // The web UI starts with several requests at once; one write is enough.
  it("is written once for requests that arrive together", async () => {
    const account = await signedInAccount("aa-parallel@example.com");
    const now = new Date("2026-03-02T08:00:00.000Z");
    let batches = 0;
    const counted = new Proxy(env.DB, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (key === "batch" && typeof value === "function") {
          return (...args: unknown[]) => {
            batches += 1;
            return Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await Promise.all([0, 1, 2, 3].map(() => recordAccountActivity(counted, account.id, api, now)));

    expect(batches).toBe(1);
    expect(await signInOf(account.id)).toBe(now.toISOString());
  });

  // Mastodon's streaming server is not Rails, so a stream is no sign-in.
  it("is not moved by a streaming connection", async () => {
    const account = await signedInAccount("aa-stream@example.com");
    const now = new Date("2026-03-01T08:00:00.000Z");

    await recordAccountActivity(
      env.DB,
      account.id,
      new Request("https://example.com/api/v1/streaming?stream=user"),
      now,
    );
    await recordAccountActivity(
      env.DB,
      account.id,
      new Request("https://example.com/api/v1/streaming/user"),
      now,
    );
    expect(await signInOf(account.id)).toBe(null);
  });
});

describe("the activity window", () => {
  it("is USER_ACTIVE_DAYS before now, 7 days unless set", () => {
    const now = new Date("2026-03-10T12:34:56.789Z");

    expect(signedInRecentlySince({}, now)).toBe(new Date(now.getTime() - 7 * DAY_MS).toISOString());
    expect(signedInRecentlySince({ USER_ACTIVE_DAYS: "30" }, now)).toBe(
      new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    );
    expect(signedInRecentlySince({ USER_ACTIVE_DAYS: "soon" }, now)).toBe(
      new Date(now.getTime() - 7 * DAY_MS).toISOString(),
    );
  });

  // `USER_ACTIVE_DAYS` past what a date can hold counts every user who
  // ever signed in, as a cutoff that far back does in Mastodon.
  it("reaches back to the earliest date for a window past the date range", () => {
    const now = new Date("2026-03-10T12:34:56.789Z");
    const earliest = new Date(-8.64e15).toISOString();

    for (const days of ["200000000", "9".repeat(400)]) {
      const since = signedInRecentlySince({ USER_ACTIVE_DAYS: days }, now);
      expect(since).toBe(earliest);
      expect(since < "1970-01-01T00:00:00.000Z").toBe(true);
    }
  });
});
