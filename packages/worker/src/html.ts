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
