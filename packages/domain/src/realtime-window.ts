import type { IsoInstant } from "./iso-instant";

/**
 * How old a newly received post may be and still stream live, as Mastodon's
 * `Status::REAL_TIME_WINDOW` (6 hours). A delivery that arrives later (a
 * remote retry, a backlog) is stored and notified but not pushed onto
 * timelines, where clients would show it as new.
 */
const REAL_TIME_WINDOW_MS = 6 * 60 * 60 * 1000;

export const RealtimeWindow = {
  /** Whether a post published at `publishedAt` is still fresh at `now`. */
  contains: (publishedAt: IsoInstant, now: IsoInstant): boolean =>
    Date.parse(now) - Date.parse(publishedAt) <= REAL_TIME_WINDOW_MS,
} as const;
