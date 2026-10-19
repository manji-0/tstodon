const HTML_ESCAPE_RE = /[&<>"]/g;
const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
} as const;

export const escapeHtml = (value: string): string =>
  value.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch as keyof typeof HTML_ESCAPE_MAP]);

export const textToHtml = (text: string): string => {
  const escaped = escapeHtml(text).replaceAll("\n", "<br>");
  return `<p>${escaped}</p>`;
};

export const mentionUsernames = (text: string): ReadonlyArray<string> => {
  const matches = text.matchAll(/@([a-z0-9_]+)/gi);
  const names = new Set<string>();
  for (const match of matches) {
    const username = match[1];
    if (username) {
      names.add(username.toLowerCase());
    }
  }
  return [...names];
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
 * Hashtags in a remote post's HTML. Mastodon renders them as
 * `#<span>name</span>` inside a link, so stripping tags with a space would
 * split the `#` from the name; these forms are matched directly.
 */
export const htmlHashtags = (html: string): string[] => {
  const tags = new Set<string>();
  const decoded = decodeHtmlEntities(html);
  for (const match of decoded.matchAll(/#(?:<span[^>]*>)?([A-Za-z0-9_]+)/g)) {
    const tag = match[1];
    if (tag) {
      tags.add(tag.toLowerCase());
    }
  }
  return [...tags];
};

/** Plain text of an HTML fragment, for keyword matching against remote posts. */
export const htmlToText = (html: string): string =>
  decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
