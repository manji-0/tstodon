import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import { isFederatedHostRefused } from "./federated-fetch";
import { decodeHtmlEntities } from "./html";
import type { OutboxJob } from "@tstodon/domain";
import {
  findLinkCard as findLinkCardSql,
  listLinkCards as listLinkCardsSql,
  listStaleLinkCards as listStaleLinkCardsSql,
  upsertLinkCard as upsertLinkCardSql,
} from "./generated/prisma/sql";
import { suspendedDomains } from "./admin-domain-block-store";
import { federationAllowHosts, parseInstanceIdentity } from "./runtime-config";
import { setRemoteStatusCard } from "./remote-status-store";
import { setStatusCard } from "./status-store";
import { queryTyped, runTyped } from "./typed-sql";

/** A small `PreviewCard`: what a client needs to render a link preview. */
export type LinkCard = Readonly<{
  url: string;
  title: string;
  description: string;
  providerName: string;
  providerUrl: string;
  authorName: string;
  authorUrl: string;
  image: string | null;
  type: string;
}>;

const MAX_HTML_CHARS = 200_000;
const FETCH_TIMEOUT_MS = 3000;
/** Previews older than this are refreshed the next time the link is posted. */
const CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** How many stale previews one cron run refreshes. */
const STALE_REFRESH_BATCH = 20;

const CardSchema = z.object({
  url: z.string().min(1),
  title: z.string(),
  description: z.string(),
  provider_name: z.string(),
  provider_url: z.string(),
  author_name: z.string(),
  author_url: z.string(),
  image: z.string().nullable(),
  type: z.string().min(1),
});

export const cardDocument = (card: LinkCard): Record<string, unknown> => ({
  url: card.url,
  title: card.title,
  description: card.description,
  type: card.type,
  author_name: card.authorName,
  author_url: card.authorUrl,
  provider_name: card.providerName,
  provider_url: card.providerUrl,
  html: "",
  width: 0,
  height: 0,
  image: card.image,
  embed_url: "",
  blurhash: null,
});

export const parseCardJson = (raw: string): LinkCard | undefined => {
  const parsed = schemaResult(CardSchema)(JSON.parse(raw));
  if (parsed.isErr()) {
    return undefined;
  }
  const value = parsed.value;
  return {
    url: value.url,
    title: value.title,
    description: value.description,
    providerName: value.provider_name,
    providerUrl: value.provider_url,
    authorName: value.author_name,
    authorUrl: value.author_url,
    image: value.image,
    type: value.type,
  };
};

/** The first http(s) link in the text, without trailing punctuation. */
export const extractFirstUrl = (text: string): string | undefined => {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const candidate = match[0].replace(/[),.;:!?]+$/, "");
    try {
      const url = new URL(candidate);
      return url.toString();
    } catch {
      continue;
    }
  }
  return undefined;
};

const metaContent = (html: string, property: string): string | undefined => {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, "i");
  const tag = pattern.exec(html)?.[0];
  if (!tag) {
    return undefined;
  }
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content && content.trim().length > 0 ? decodeHtmlEntities(content.trim()) : undefined;
};

const absolute = (value: string | undefined, base: string): string | null => {
  if (value === undefined) {
    return null;
  }
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
};

/** Open Graph / `<title>` fields; only what a preview needs. */
export const parseLinkCard = (html: string, url: string): LinkCard => {
  const document = html.slice(0, MAX_HTML_CHARS);
  const parsed = new URL(url);
  const title =
    metaContent(document, "og:title") ??
    decodeHtmlEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(document)?.[1]?.trim() ?? "");
  const description =
    metaContent(document, "og:description") ?? metaContent(document, "description") ?? "";
  const siteName = metaContent(document, "og:site_name") ?? parsed.hostname;
  return {
    url,
    title,
    description,
    providerName: siteName,
    providerUrl: `${parsed.protocol}//${parsed.hostname}`,
    authorName: metaContent(document, "article:author") ?? "",
    authorUrl: absolute(metaContent(document, "article:author"), url) ?? "",
    image: absolute(metaContent(document, "og:image"), url),
    type: "link",
  };
};

const cachedCard = async (
  db: D1Database,
  url: string,
): Promise<Result<Readonly<{ card: LinkCard; fresh: boolean }> | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ card_json: string; fetched_at: string }>(
      db,
      findLinkCardSql(url),
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    const card = parseCardJson(row.card_json);
    if (!card) {
      return undefined;
    }
    const fetched = Date.parse(row.fetched_at);
    return { card, fresh: Number.isFinite(fetched) && Date.now() - fetched < CARD_TTL_MS };
  });

/**
 * Unfurl outcome: `Transient` is worth retrying, everything else is settled.
 */
export type LinkCardOutcome =
  | Readonly<{ kind: "Built"; card: LinkCard }>
  | Readonly<{ kind: "Cached"; card: LinkCard }>
  | Readonly<{ kind: "Skipped" }>
  | Readonly<{ kind: "Transient" }>;

/**
 * Preview card for a link, from the cache when possible. Fetching is bounded
 * (3 s, 200 kB) and refused for hosts the federation rules already reject, so a
 * slow or hostile host cannot make a request fail or reach into the network.
 * Called from the queue, never from a request path.
 */
export const resolveLinkCard = async (
  env: Env,
  identity: InstanceIdentity,
  url: string,
  options: Readonly<{
    allowHosts?: ReadonlySet<string>;
    blockedHosts?: ReadonlySet<string>;
  }> = {},
): Promise<LinkCardOutcome> => {
  const cached = await cachedCard(env.DB, url);
  if (cached.isErr()) {
    return { kind: "Transient" };
  }
  if (cached.value?.fresh) {
    return { kind: "Cached", card: cached.value.card };
  }
  // A stale preview is refreshed below; if the refresh fails we keep serving it.
  const stale = cached.value?.card;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "Skipped" };
  }
  if (isFederatedHostRefused(parsed.hostname, identity.domain, options)) {
    return { kind: "Skipped" };
  }
  let response: Response;
  try {
    response = await fetch(parsed, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": `tstodon (${identity.publicOrigin})`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // Timeouts and network errors are worth another attempt.
    return stale ? { kind: "Cached", card: stale } : { kind: "Transient" };
  }
  if (response.status >= 500) {
    return stale ? { kind: "Cached", card: stale } : { kind: "Transient" };
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("html")) {
    return stale ? { kind: "Cached", card: stale } : { kind: "Skipped" };
  }
  let html: string;
  try {
    html = (await response.text()).slice(0, MAX_HTML_CHARS);
  } catch {
    return stale ? { kind: "Cached", card: stale } : { kind: "Transient" };
  }
  const card = parseLinkCard(html, url);
  // The card is cached so the same link is never unfurled twice.
  const stored = await cacheLinkCard(env.DB, url, card);
  if (stored.isErr()) {
    return stale ? { kind: "Cached", card: stale } : { kind: "Transient" };
  }
  return { kind: "Built", card };
};

/** Convenience wrapper: the card, or `undefined` when there is none. */
export const buildLinkCard = async (
  env: Env,
  identity: InstanceIdentity,
  url: string,
  options: Readonly<{
    allowHosts?: ReadonlySet<string>;
    blockedHosts?: ReadonlySet<string>;
  }> = {},
): Promise<LinkCard | undefined> => {
  const outcome = await resolveLinkCard(env, identity, url, options);
  return outcome.kind === "Built" || outcome.kind === "Cached" ? outcome.card : undefined;
};

/** URLs whose cached preview has aged out, oldest first. */
export const listStaleLinkCardUrls = async (
  db: D1Database,
  limit: number,
): Promise<ReadonlyArray<string>> => {
  const before = new Date(Date.now() - CARD_TTL_MS).toISOString();
  const queried = await runD1(async () =>
    queryTyped<{ url: string }>(db, listStaleLinkCardsSql(before, limit)),
  );
  return queried.isOk() ? queried.value.map((row) => row.url) : [];
};

/** Store a card in the URL cache (what the unfurl writes). */
export const cacheLinkCard = async (
  db: D1Database,
  url: string,
  card: LinkCard,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(db, upsertLinkCardSql(url, JSON.stringify(cardDocument(card)), nowIso()));
  });
  return written.map(() => undefined);
};

/** Cached cards for the given URLs, keyed by URL. */
export const listCachedLinkCards = async (
  db: D1Database,
  urls: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, LinkCard>> => {
  const unique = [...new Set(urls.filter((url) => url.length > 0))];
  if (unique.length === 0) {
    return new Map<string, LinkCard>();
  }
  const queried = await runD1(async () =>
    queryTyped<{ url: string; card_json: string }>(db, listLinkCardsSql(jsonStringArray(unique))),
  );
  if (queried.isErr()) {
    return new Map<string, LinkCard>();
  }
  const cards = new Map<string, LinkCard>();
  for (const row of queried.value) {
    const card = parseCardJson(row.card_json);
    if (card) {
      cards.set(row.url, card);
    }
  }
  return cards;
};

/**
 * Cron path: refresh the oldest stale previews, a bounded batch per run.
 * Failures leave the existing (stale) card in place.
 */
export const refreshStaleLinkCards = async (env: Env): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const urls = await listStaleLinkCardUrls(env.DB, STALE_REFRESH_BATCH);
  if (urls.length === 0) {
    return;
  }
  const options = {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  };
  for (const url of urls) {
    await resolveLinkCard(env, identity.value, url, options);
  }
};

/** Queue the unfurl for a stored status (or remote status); never blocks a request. */
export const enqueueLinkCard = async (
  env: Env,
  target: "Status" | "RemoteStatus",
  id: string,
  text: string,
): Promise<void> => {
  const url = extractFirstUrl(text);
  if (!url) {
    return;
  }
  await env.OUTBOX_PROCESS_QUEUE.send({ kind: "ProcessLinkCard", target, id, url });
};

/**
 * Queue handler: unfurl and store the card for one status. Returns `"retry"`
 * for transient failures (timeouts, 5xx, storage errors) so the queue can try
 * again; a refused or non-HTML link is settled and never retried.
 */
export const processLinkCardJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "ProcessLinkCard" }>,
): Promise<"ok" | "retry"> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return "retry";
  }
  const outcome = await resolveLinkCard(env, identity.value, job.url, {
    allowHosts: await federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  });
  if (outcome.kind === "Transient") {
    return "retry";
  }
  if (outcome.kind === "Skipped") {
    return "ok";
  }
  const cardJson = JSON.stringify(cardDocument(outcome.card));
  const stored =
    job.target === "Status"
      ? await setStatusCard(env.DB, job.id, cardJson)
      : await setRemoteStatusCard(env.DB, job.id, cardJson);
  return stored.isErr() ? "retry" : "ok";
};
