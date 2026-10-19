import { schemaResult } from "@tstodon/core";
import type { InstanceIdentity } from "@tstodon/domain";
import type { Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { runD1, type RepositoryError } from "./d1";
import { isFederatedHostRefused } from "./federated-fetch";
import { decodeHtmlEntities } from "./html";
import type { OutboxJob } from "@tstodon/domain";
import {
  findLinkCard as findLinkCardSql,
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
): Promise<Result<LinkCard | undefined, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped<{ card_json: string }>(db, findLinkCardSql(url));
    const raw = rows[0]?.card_json;
    return raw === undefined ? undefined : parseCardJson(raw);
  });

/**
 * Build the preview card for a link and cache it. Fetching is bounded
 * (3 s, 200 kB) and refused for hosts the federation rules already reject, so a
 * slow or hostile host cannot make a request fail or reach into the network.
 * Called from the queue, never from a request path.
 */
export const buildLinkCard = async (
  env: Env,
  identity: InstanceIdentity,
  url: string,
  options: Readonly<{
    allowHosts?: ReadonlySet<string>;
    blockedHosts?: ReadonlySet<string>;
  }> = {},
): Promise<LinkCard | undefined> => {
  const cached = await cachedCard(env.DB, url);
  if (cached.isErr()) {
    return undefined;
  }
  if (cached.value) {
    return cached.value;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (isFederatedHostRefused(parsed.hostname, identity.domain, options)) {
    return undefined;
  }
  try {
    const response = await fetch(parsed, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": `tstodon (${identity.publicOrigin})`,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("html")) {
      return undefined;
    }
    const html = (await response.text()).slice(0, MAX_HTML_CHARS);
    const card = parseLinkCard(html, url);
    // The card is cached so the same link is never unfurled twice.
    await runD1(async () => {
      await runTyped(env.DB, upsertLinkCardSql(url, JSON.stringify(cardDocument(card)), nowIso()));
    });
    return card;
  } catch {
    return undefined;
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

/** Queue handler: unfurl and store the card for one status. */
export const processLinkCardJob = async (
  env: Env,
  job: Extract<OutboxJob, { kind: "ProcessLinkCard" }>,
): Promise<void> => {
  const identity = parseInstanceIdentity(env);
  if (identity.isErr()) {
    return;
  }
  const card = await buildLinkCard(env, identity.value, job.url, {
    allowHosts: federationAllowHosts(env),
    blockedHosts: await suspendedDomains(env.DB),
  });
  if (!card) {
    return;
  }
  const cardJson = JSON.stringify(cardDocument(card));
  if (job.target === "Status") {
    await setStatusCard(env.DB, job.id, cardJson);
    return;
  }
  await setRemoteStatusCard(env.DB, job.id, cardJson);
};
