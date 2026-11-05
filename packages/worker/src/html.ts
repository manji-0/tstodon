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

/**
 * `@user` and `@user@domain` handles in post text. An `@` inside a word (an
 * email address) does not start a mention; a username may carry `.` or `-`
 * inside it (remote servers allow them), and the domain needs a dot and ends
 * before trailing punctuation.
 */
const mentionHandles = (text: string): ReadonlyArray<{ username: string; domain?: string }> =>
  [
    ...text.matchAll(
      /(?<![\w@])@([a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)(?:@([a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?))?/gi,
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

/** Plain text of an HTML fragment, for keyword matching against remote posts. */
export const htmlToText = (html: string): string =>
  decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
