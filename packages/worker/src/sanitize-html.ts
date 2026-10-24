import { escapeHtml } from "./html";

/**
 * Remote post HTML reduced to what Mastodon itself keeps
 * (`Sanitize::Config::MASTODON_STRICT`), so another server's markup cannot
 * run script or restyle the web UI that renders it as HTML.
 *
 * The output is rebuilt from scratch: every tag in it is one written here
 * from the allow-list, every attribute value and text run is escaped. Input
 * the tokenizer does not understand becomes escaped text, never markup.
 */

const ALLOWED_ELEMENTS = new Set([
  "p",
  "br",
  "span",
  "a",
  "abbr",
  "del",
  "s",
  "pre",
  "blockquote",
  "code",
  "b",
  "strong",
  "u",
  "i",
  "em",
  "ul",
  "ol",
  "li",
  "ruby",
  "rt",
  "rp",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const VOID_ELEMENTS = new Set(["br"]);

/** Elements dropped together with everything inside them. */
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "style",
  "template",
  "iframe",
  "object",
  "embed",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "textarea",
  "title",
  "svg",
  "math",
  "select",
]);

const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "class", "translate"]),
  span: new Set(["class", "translate"]),
  abbr: new Set(["title"]),
  ol: new Set(["start", "reversed"]),
  li: new Set(["value"]),
};

const LINK_PROTOCOLS = new Set([
  "http:",
  "https:",
  "dat:",
  "dweb:",
  "ipfs:",
  "ipns:",
  "ssb:",
  "gopher:",
  "xmpp:",
  "magnet:",
  "gemini:",
]);

/** Microformats and the classes Mastodon's own markup uses. */
const ALLOWED_CLASS = /^(?:[hpuedt]{1,2}-[\w-]+|mention|hashtag|ellipsis|invisible)$/;

const TAG =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const ENTITY = /^&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  tab: "\t",
  newline: "\n",
};

/** Attribute value as the browser reads it (numeric and common named entities). */
const decodeAttribute = (value: string): string =>
  value.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);?/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "�";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });

/** Text kept as written, but with every `<`/`>` and stray `&` escaped. */
const escapeText = (text: string): string => {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "&") {
      const entity = ENTITY.exec(text.slice(i));
      if (entity) {
        out += entity[0];
        i += entity[0].length - 1;
      } else {
        out += "&amp;";
      }
    } else if (ch === "<") {
      out += "&lt;";
    } else if (ch === ">") {
      out += "&gt;";
    } else {
      out += ch;
    }
  }
  return out;
};

const safeHref = (raw: string): string | undefined => {
  const value = decodeAttribute(raw).trim();
  if (!URL.canParse(value)) {
    return undefined;
  }
  return LINK_PROTOCOLS.has(new URL(value).protocol) ? value : undefined;
};

const safeAttributes = (element: string, source: string): string => {
  const allowed = ALLOWED_ATTRIBUTES[element];
  if (!allowed) {
    return "";
  }
  const kept = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!allowed.has(name) || kept.has(name)) {
      continue;
    }
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    if (name === "href") {
      const href = safeHref(raw);
      if (href !== undefined) {
        kept.set(name, href);
      }
    } else if (name === "class") {
      const classes = decodeAttribute(raw)
        .split(/\s+/)
        .filter((token) => ALLOWED_CLASS.test(token));
      if (classes.length > 0) {
        kept.set(name, classes.join(" "));
      }
    } else if (name === "start" || name === "value") {
      if (/^-?\d{1,9}$/.test(raw.trim())) {
        kept.set(name, raw.trim());
      }
    } else if (name === "reversed") {
      kept.set(name, "");
    } else {
      kept.set(name, decodeAttribute(raw));
    }
  }
  let out = "";
  for (const [name, value] of kept) {
    out += name === "reversed" ? " reversed" : ` ${name}="${escapeHtml(value)}"`;
  }
  return element === "a" ? `${out} rel="nofollow noopener" target="_blank"` : out;
};

export const sanitizeRemoteHtml = (html: string): string => {
  let out = "";
  let text = "";
  const open: string[] = [];
  let i = 0;
  const flushText = (): void => {
    out += escapeText(text);
    text = "";
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    const rest = html.slice(lt);
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->", 4);
      i = end === -1 ? html.length : lt + end + 3;
      continue;
    }
    if (rest.startsWith("<!") || rest.startsWith("<?")) {
      const end = rest.indexOf(">");
      i = end === -1 ? html.length : lt + end + 1;
      continue;
    }
    const tag = TAG.exec(rest);
    if (!tag) {
      text += "<";
      i = lt + 1;
      continue;
    }
    i = lt + tag[0].length;
    const closing = tag[1] === "/";
    const name = (tag[2] ?? "").toLowerCase();
    if (!closing && DROPPED_WITH_CONTENT.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, "i").exec(html.slice(i));
      i = end ? i + end.index + end[0].length : html.length;
      continue;
    }
    if (!ALLOWED_ELEMENTS.has(name)) {
      continue;
    }
    flushText();
    if (VOID_ELEMENTS.has(name)) {
      if (!closing) {
        out += `<${name}>`;
      }
      continue;
    }
    if (!closing) {
      out += `<${name}${safeAttributes(name, tag[3] ?? "")}>`;
      open.push(name);
      continue;
    }
    const at = open.lastIndexOf(name);
    if (at === -1) {
      continue;
    }
    while (open.length > at) {
      out += `</${open.pop()}>`;
    }
  }
  flushText();
  while (open.length > 0) {
    out += `</${open.pop()}>`;
  }
  return out;
};

/** An `http(s)` URL, or undefined: links the UI renders must not be `javascript:` and the like. */
export const httpUrl = (value: string | undefined): string | undefined => {
  if (value === undefined || !URL.canParse(value)) {
    return undefined;
  }
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:" ? value : undefined;
};
