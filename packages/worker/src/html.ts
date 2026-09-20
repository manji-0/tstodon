export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

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
