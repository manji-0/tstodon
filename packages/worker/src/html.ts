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

/**
 * `@user` and `@user@domain` handles in post text. An `@` inside a word (an
 * email address) does not start a mention; a username may carry `.` or `-`
 * inside it (remote servers allow them), and the domain needs a dot and ends
 * before trailing punctuation.
 */
const mentionHandles = (text: string): ReadonlyArray<{ username: string; domain?: string }> =>
  [
    ...text.matchAll(
      /(?<![\w@])@([a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)(?:@([a-z0-9-]+(?:\.[a-z0-9-]+)+))?/gi,
    ),
  ].flatMap((match) => {
    const username = match[1];
    if (!username) {
      return [];
    }
    const domain = match[2];
    return [
      domain
        ? { username: username.toLowerCase(), domain: domain.toLowerCase() }
        : { username: username.toLowerCase() },
    ];
  });

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
  const seen = new Map<string, { username: string; domain: string }>();
  for (const handle of mentionHandles(text)) {
    if (handle.domain !== undefined && handle.domain !== own) {
      seen.set(`${handle.username}@${handle.domain}`, {
        username: handle.username,
        domain: handle.domain,
      });
    }
  }
  return [...seen.values()];
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
