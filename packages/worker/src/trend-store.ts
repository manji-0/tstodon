import { err, ok, type Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { cardDocument, listCachedLinkCards, normalizeLinkUrl } from "./link-card";
import { listTrendingStatuses } from "./status-discovery-store";

/** Links are counted from the text of this many trending statuses. */
const TREND_WINDOW = 100;

const LINK_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

/** A bare card for a link that has not been unfurled yet. */
export const fallbackLinkCard = (url: string): Record<string, unknown> | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.host;
  return {
    url,
    title: host,
    description: "",
    type: "link",
    author_name: "",
    author_url: "",
    provider_name: host,
    provider_url: `${parsed.protocol}//${host}`,
    html: "",
    width: 0,
    height: 0,
    image: null,
    blurhash: null,
    embed_url: "",
  };
};

export type TrendingLink = Readonly<{
  url: string;
  uses: number;
  document: Record<string, unknown>;
}>;

const HISTORY_DAYS = 7;
const SECONDS_PER_DAY = 24 * 60 * 60;

/** Uses of one link, in total and per UTC day (epoch seconds) with the sharing accounts. */
type LinkUsage = {
  uses: number;
  days: Map<number, { uses: number; accounts: Set<string> }>;
};

/** How often each link appears in the text of recent trending statuses. */
const trendingLinkUses = async (
  db: D1Database,
): Promise<Result<Map<string, LinkUsage>, RepositoryError>> => {
  const statuses = await listTrendingStatuses(db, TREND_WINDOW);
  if (statuses.isErr()) {
    return err(statuses.error);
  }
  const counts = new Map<string, LinkUsage>();
  for (const status of statuses.value) {
    if (status.kind !== "LocalNote") {
      continue;
    }
    const day = Math.floor(Date.parse(status.createdAt) / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
    for (const match of status.text.matchAll(LINK_PATTERN)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      const usage = counts.get(url) ?? { uses: 0, days: new Map() };
      usage.uses += 1;
      const daily = usage.days.get(day) ?? { uses: 0, accounts: new Set<string>() };
      daily.uses += 1;
      daily.accounts.add(status.accountId);
      usage.days.set(day, daily);
      counts.set(url, usage);
    }
  }
  return ok(counts);
};

/** Mastodon's `Trends::Link` history: the last week, newest first, zero-filled. */
const linkHistory = (usage: LinkUsage): ReadonlyArray<Record<string, string>> => {
  const today = Math.floor(Date.now() / 1000 / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  return Array.from({ length: HISTORY_DAYS }, (_, offset) => {
    const day = today - offset * SECONDS_PER_DAY;
    const daily = usage.days.get(day);
    return {
      day: String(day),
      uses: String(daily?.uses ?? 0),
      accounts: String(daily?.accounts.size ?? 0),
    };
  });
};

/**
 * The trending link `url` names, as cards key it, or `undefined` when the link
 * is not trending (or a moderator rejected it). Gates the link timeline.
 */
export const findTrendingLinkUrl = async (
  db: D1Database,
  url: string,
  excluded: ReadonlySet<string>,
): Promise<Result<string | undefined, RepositoryError>> => {
  const wanted = normalizeLinkUrl(url);
  if (!wanted) {
    return ok(undefined);
  }
  const counts = await trendingLinkUses(db);
  if (counts.isErr()) {
    return err(counts.error);
  }
  const trending = [...counts.value.keys()].some(
    (link) => !excluded.has(link) && normalizeLinkUrl(link) === wanted,
  );
  return ok(trending ? wanted : undefined);
};

/**
 * The links shared most often in recent trending statuses, ranked by uses. The
 * cached preview supplies the title, description, and image when one exists.
 */
export const listTrendingLinks = async (
  db: D1Database,
  options: Readonly<{ limit: number; offset?: number; excluded?: ReadonlySet<string> }>,
): Promise<Result<ReadonlyArray<TrendingLink>, RepositoryError>> => {
  const counts = await trendingLinkUses(db);
  if (counts.isErr()) {
    return err(counts.error);
  }
  const offset = options.offset ?? 0;
  const ranked = [...counts.value.entries()]
    .filter(([url]) => !options.excluded?.has(url))
    .toSorted((left, right) => right[1].uses - left[1].uses || left[0].localeCompare(right[0]))
    .slice(offset, offset + options.limit);
  // Prefer the unfurled card when the link has been previewed, so trends
  // report real titles, descriptions, and images.
  const cached = await listCachedLinkCards(
    db,
    ranked.map(([url]) => url),
  );
  const links: TrendingLink[] = [];
  for (const [url, usage] of ranked) {
    const preview = cached.get(url);
    const card = preview ? cardDocument(preview) : fallbackLinkCard(url);
    if (card) {
      links.push({ url, uses: usage.uses, document: { ...card, history: linkHistory(usage) } });
    }
  }
  return ok(links);
};
