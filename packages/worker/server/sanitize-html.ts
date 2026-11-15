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

const TAG_START = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y;
const SPACES = /\s*/y;
const ATTRIBUTE_NAME = /[^\s"'>/=]+/y;
const UNQUOTED_VALUE = /[^\s"'>]+/y;

/** Where the run `pattern` (a sticky expression) matches at `from` ends; `from` when it matches nothing. */
const runEnd = (pattern: RegExp, html: string, from: number): number => {
  pattern.lastIndex = from;
  return pattern.test(html) ? pattern.lastIndex : from;
};

/** Where a tag scan stands between two tokens. */
const AFTER_NAME_OR_VALUE = 0;
const AFTER_ATTRIBUTE_NAME = 1;
const BEFORE_ATTRIBUTE_NAME = 2;
const AFTER_EQUALS = 3;
const SCAN_STATES = 4;

/**
 * The scans that found no tag, as the places they stood at: a scan that comes
 * to stand at one of them, in the same state, finds no tag either. A scan
 * reads on from a place by what the text holds there and nothing before it,
 * so every place is read at most once per state however many `<` a text has,
 * and sanitising takes time linear in its length.
 */
export type FailedTagScans = { places: Uint8Array | undefined };

export type Tag = Readonly<{
  /** The index after the tag's `>`. */
  end: number;
  closing: boolean;
  name: string;
  /** The attributes as written, from the name to the last one's end. */
  attributes: string;
}>;

/**
 * The tag that starts at `at`, where `html` has a `<`:
 *
 *     <(/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+NAME(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>
 *
 * with `NAME` as `[^\s"'>/=]+`. It is read token by token and not with that
 * one expression, which reads to the end of the text for each `<` of a text
 * such as `<a <a <a`. `failed` is shared by the scans of one text.
 */
export const tagAt = (html: string, at: number, failed: FailedTagScans): Tag | undefined => {
  TAG_START.lastIndex = at;
  const start = TAG_START.exec(html);
  if (!start) {
    return undefined;
  }
  const attributesFrom = at + start[0].length;
  let attributesEnd = attributesFrom;
  let position = attributesFrom;
  let state = AFTER_NAME_OR_VALUE;
  const stood: number[] = [];
  for (;;) {
    const place = position * SCAN_STATES + state;
    if (failed.places?.[place] === 1) {
      break;
    }
    stood.push(place);
    if (state === BEFORE_ATTRIBUTE_NAME) {
      const end = runEnd(ATTRIBUTE_NAME, html, position);
      if (end === position) {
        break;
      }
      position = end;
      attributesEnd = end;
      state = AFTER_ATTRIBUTE_NAME;
      continue;
    }
    if (state === AFTER_EQUALS) {
      const from = runEnd(SPACES, html, position);
      const quote = html[from];
      const close = quote === '"' || quote === "'" ? html.indexOf(quote, from + 1) : -1;
      const end = quote === '"' || quote === "'" ? close + 1 : runEnd(UNQUOTED_VALUE, html, from);
      if (end === 0 || end === from) {
        break;
      }
      position = end;
      attributesEnd = end;
      state = AFTER_NAME_OR_VALUE;
      continue;
    }
    const spacesEnd = runEnd(SPACES, html, position);
    if (state === AFTER_ATTRIBUTE_NAME && html[spacesEnd] === "=") {
      position = spacesEnd + 1;
      state = AFTER_EQUALS;
      continue;
    }
    const end =
      html[spacesEnd] === ">"
        ? spacesEnd + 1
        : html[spacesEnd] === "/" && html[spacesEnd + 1] === ">"
          ? spacesEnd + 2
          : undefined;
    if (end !== undefined) {
      return {
        end,
        closing: start[1] === "/",
        name: start[2] ?? "",
        attributes: html.slice(attributesFrom, attributesEnd),
      };
    }
    if (spacesEnd === position) {
      break;
    }
    position = spacesEnd;
    state = BEFORE_ATTRIBUTE_NAME;
  }
  failed.places ??= new Uint8Array((html.length + 1) * SCAN_STATES);
  for (const place of stood) {
    failed.places[place] = 1;
  }
  return undefined;
};

const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const ENTITY = /&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;

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
      ENTITY.lastIndex = i;
      const entity = ENTITY.exec(text);
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
  const out = [...kept]
    .map(([name, value]) => (name === "reversed" ? " reversed" : ` ${name}="${escapeHtml(value)}"`))
    .join("");
  return element === "a" ? `${out} rel="nofollow noopener" target="_blank"` : out;
};

export const sanitizeRemoteHtml = (html: string): string => {
  let out = "";
  let text = "";
  const open: string[] = [];
  /** How many of each element are open, so a closing tag that closes nothing does not search `open`. */
  const openCount = new Map<string, number>();
  const failed: FailedTagScans = { places: undefined };
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
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = tagAt(html, lt, failed);
    if (!tag) {
      text += "<";
      i = lt + 1;
      continue;
    }
    i = tag.end;
    const { closing } = tag;
    const name = tag.name.toLowerCase();
    if (!closing && DROPPED_WITH_CONTENT.has(name)) {
      const closer = new RegExp(`</${name}\\s*>`, "gi");
      closer.lastIndex = i;
      i = closer.test(html) ? closer.lastIndex : html.length;
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
      out += `<${name}${safeAttributes(name, tag.attributes)}>`;
      open.push(name);
      openCount.set(name, (openCount.get(name) ?? 0) + 1);
      continue;
    }
    if ((openCount.get(name) ?? 0) === 0) {
      continue;
    }
    for (let closed = open.pop(); closed !== undefined; closed = open.pop()) {
      out += `</${closed}>`;
      openCount.set(closed, (openCount.get(closed) ?? 1) - 1);
      if (closed === name) {
        break;
      }
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
