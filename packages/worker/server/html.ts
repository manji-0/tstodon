import { extractEntities, normalizeHashtag, type PostEntity } from "@tstodon/core/post-text";
import type { InstanceIdentity } from "@tstodon/domain";
import { tagUrl } from "./tag-documents";

const HTML_ESCAPE_RE = /[&<>"]/g;
const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export const escapeHtml = (value: string): string =>
  value.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);

export const textToHtml = (text: string): string => {
  const escaped = escapeHtml(text).replaceAll("\n", "<br>");
  return `<p>${escaped}</p>`;
};

/** An account post text mentions: `domain` null on this instance, `url` the REST `mentions[].url`. */
export type PostMention = Readonly<{ username: string; domain: string | null; url: string }>;

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Mastodon's `TextFormatter.shortened_link`: the scheme and what is past 30 characters are hidden. */
const shortenedLink = (url: string): string => {
  const prefix = /^(?:https?:\/\/(?:www\.)?|xmpp:)/.exec(url)?.[0] ?? "";
  const rest = Array.from(url.slice(prefix.length));
  // A one-character suffix is shown: the ellipsis would take as much room.
  const shown = rest.length === 31 ? 31 : 30;
  const hidden = rest.slice(shown).join("");
  return `<a href="${escapeHtml(url)}" target="_blank" rel="nofollow noopener" translate="no"><span class="invisible">${escapeHtml(prefix)}</span><span class="${hidden.length > 0 ? "ellipsis" : ""}">${escapeHtml(rest.slice(0, shown).join(""))}</span><span class="invisible">${escapeHtml(hidden)}</span></a>`;
};

/**
 * Mastodon's `TextFormatter#link_to_mention`: the account's link, or the
 * handle as text when no mentioned account has it. The domain shows when
 * another mentioned account has the username.
 */
const mentionLink = (
  entity: Extract<PostEntity, { kind: "Mention" }>,
  identity: InstanceIdentity,
  mentions: ReadonlyArray<PostMention>,
): string => {
  const domain =
    entity.domain === undefined || sameText(entity.domain, identity.domain) ? null : entity.domain;
  const named = mentions.filter((mention) => sameText(mention.username, entity.username));
  const account = named.find((mention) =>
    mention.domain === null || domain === null
      ? mention.domain === domain
      : sameText(mention.domain, domain),
  );
  if (account === undefined) {
    return escapeHtml(
      `@${entity.username}${entity.domain === undefined ? "" : `@${entity.domain}`}`,
    );
  }
  const shown =
    new Set(named.map((mention) => mention.url)).size > 1 && account.domain !== null
      ? `${account.username}@${account.domain}`
      : account.username;
  return `<span class="h-card" translate="no"><a href="${escapeHtml(account.url)}" class="u-url mention">@<span>${escapeHtml(shown)}</span></a></span>`;
};

/**
 * A local post's HTML, as Mastodon's `TextFormatter`: URLs, hashtags and the
 * mentions in `mentions` are links, a blank line starts a paragraph and a
 * newline is a `<br />` (Rails' `simple_format`). Nothing sanitizes it
 * afterwards, so every piece of the text is escaped here. A hashtag links
 * to its normalized name's page (the REST `tags[].url`), where Mastodon
 * links the name as written.
 */
export const formatPostText = (
  text: string,
  options: Readonly<{ identity: InstanceIdentity; mentions: ReadonlyArray<PostMention> }>,
): string => {
  if (text.trim().length === 0) {
    return "";
  }
  let html = "";
  let index = 0;
  for (const entity of extractEntities(text)) {
    html += escapeHtml(text.slice(index, entity.start));
    html +=
      entity.kind === "Url"
        ? shortenedLink(entity.url)
        : entity.kind === "Hashtag"
          ? `<a href="${escapeHtml(tagUrl(options.identity, normalizeHashtag(entity.name)))}" class="mention hashtag" rel="tag">#<span>${escapeHtml(entity.name)}</span></a>`
          : mentionLink(entity, options.identity, options.mentions);
    index = entity.end;
  }
  html += escapeHtml(text.slice(index));
  return html
    .replace(/\r\n?/g, "\n")
    .split(/\n\n+/)
    .map((paragraph) => paragraph.replace(/([^\n])\n(?=[^\n])/g, "$1<br />").replaceAll("\n", ""))
    .map((paragraph) => `<p>${paragraph}</p>`)
    .join("")
    .replace(/(?:<p><\/p>)+$/, "");
};

/** The mentions Mastodon finds in post text (`@user`, `@user@domain`), lowercased. */
const mentionHandles = (text: string): ReadonlyArray<{ username: string; domain?: string }> =>
  extractEntities(text).flatMap((entity) =>
    entity.kind !== "Mention"
      ? []
      : entity.domain === undefined
        ? [{ username: entity.username.toLowerCase() }]
        : [{ username: entity.username.toLowerCase(), domain: entity.domain.toLowerCase() }],
  );

/** Local usernames a post mentions: bare `@user`, or a handle on this instance's domain. */
export const mentionUsernames = (text: string, localDomain: string): ReadonlyArray<string> => {
  const own = localDomain.toLowerCase();
  return [
    ...new Set(
      mentionHandles(text).flatMap((handle) =>
        handle.domain === undefined || handle.domain === own ? [handle.username] : [],
      ),
    ),
  ];
};

/** `user@domain` handles a post mentions on other instances. */
export const remoteMentionHandles = (
  text: string,
  localDomain: string,
): ReadonlyArray<Readonly<{ username: string; domain: string }>> => {
  const own = localDomain.toLowerCase();
  const remote = mentionHandles(text).flatMap(({ username, domain }) =>
    domain !== undefined && domain !== own ? [{ username, domain }] : [],
  );
  return [
    ...new Map(remote.map((handle) => [`${handle.username}@${handle.domain}`, handle])).values(),
  ];
};

/** Decode the entities our own renderers produce (and the common ones). */
export const decodeHtmlEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ");

/**
 * Plain text of an HTML fragment, for keyword matching and notification
 * bodies: a block or line break is a space, an inline tag (a link, its
 * `invisible` spans) is nothing, so `@<span>alice</span>` reads `@alice`.
 */
export const htmlToText = (html: string): string =>
  decodeHtmlEntities(
    html
      .replace(/<(?:br|\/?(?:p|div|li|ul|ol|blockquote|pre|h[1-6]))\b[^>]*>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\s+/g, " ")
    .trim();
