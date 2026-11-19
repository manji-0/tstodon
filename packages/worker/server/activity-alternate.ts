/**
 * Where a page names its ActivityPub document, as Mastodon's
 * `FetchResourceService` reads it: a `Link` header or an HTML
 * `<link rel="alternate">` of one of these types.
 */
const ACTIVITY_STREAM_LINK_TYPES = [
  "application/activity+json",
  'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
] as const;

type LinkValue = Readonly<{ href: string; params: ReadonlyMap<string, string> }>;

/**
 * The links of an RFC 8288 `Link` header: `<href>` and its parameters, a
 * quoted value read with its backslash escapes. Parameter names are lower
 * case; a later repeat of a name is ignored.
 */
const parseLinkHeader = (header: string): ReadonlyArray<LinkValue> => {
  const links: LinkValue[] = [];
  let at = 0;
  const skip = (pattern: RegExp): void => {
    while (at < header.length && pattern.test(header.charAt(at))) {
      at += 1;
    }
  };
  while (at < header.length) {
    const open = header.indexOf("<", at);
    const close = open === -1 ? -1 : header.indexOf(">", open);
    if (close === -1) {
      break;
    }
    const href = header.slice(open + 1, close).trim();
    const params = new Map<string, string>();
    at = close + 1;
    for (;;) {
      skip(/\s/);
      if (header.charAt(at) !== ";") {
        break;
      }
      at += 1;
      skip(/\s/);
      const nameStart = at;
      skip(/[^=;,\s]/);
      const name = header.slice(nameStart, at).toLowerCase();
      skip(/\s/);
      let value = "";
      if (header.charAt(at) === "=") {
        at += 1;
        skip(/\s/);
        if (header.charAt(at) === '"') {
          at += 1;
          while (at < header.length && header.charAt(at) !== '"') {
            if (header.charAt(at) === "\\") {
              at += 1;
            }
            value += header.charAt(at);
            at += 1;
          }
          at += 1;
        } else {
          const valueStart = at;
          skip(/[^;,]/);
          value = header.slice(valueStart, at).trim();
        }
      }
      if (name.length > 0 && !params.has(name)) {
        params.set(name, value);
      }
    }
    links.push({ href, params });
    skip(/[\s,]/);
  }
  return links;
};

/**
 * The `href` of the `Link` header's `rel="alternate"` link to an ActivityPub
 * document, an `application/activity+json` one before an
 * `application/ld+json` one, as Mastodon's `process_link_headers`.
 */
export const linkHeaderAlternate = (header: string | null): string | undefined => {
  if (header === null) {
    return undefined;
  }
  const links = parseLinkHeader(header);
  for (const type of ACTIVITY_STREAM_LINK_TYPES) {
    const link = links.find(
      (candidate) =>
        candidate.params.get("rel") === "alternate" && candidate.params.get("type") === type,
    );
    if (link) {
      return link.href;
    }
  }
  return undefined;
};

/**
 * The `href` of the first `<link>` in `html` whose `rel` includes
 * `alternate` and whose `type` names an ActivityPub document, as Mastodon's
 * `process_html`.
 */
export const htmlAlternate = async (html: string): Promise<string | undefined> => {
  let found: string | undefined;
  const rewriter = new HTMLRewriter().on("link", {
    element: (element) => {
      if (found !== undefined) {
        return;
      }
      const rel = (element.getAttribute("rel") ?? "").split(/\s+/);
      const type = element.getAttribute("type") ?? "";
      const href = element.getAttribute("href");
      if (
        rel.includes("alternate") &&
        ACTIVITY_STREAM_LINK_TYPES.some((linkType) => linkType === type) &&
        href !== null
      ) {
        found = href;
      }
    },
  });
  await rewriter.transform(new Response(html, { headers: { "content-type": "text/html" } })).text();
  return found;
};
