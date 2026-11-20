/**
 * Structured Field Values for HTTP (RFC 8941), the syntax of RFC 9421's
 * `Signature-Input` and `Signature` and RFC 9530's `Content-Digest`. Parsed
 * as the RFC's section 4.2 parses them, as Mastodon's `starry` gem does:
 * any deviation fails the whole field. Only what those fields use is here:
 * dictionaries, inner lists, items and parameters.
 */
import { err, ok, type Result } from "neverthrow";

export type SfBareItem =
  | Readonly<{ kind: "Integer"; value: number }>
  | Readonly<{ kind: "Decimal"; value: number }>
  | Readonly<{ kind: "String"; value: string }>
  | Readonly<{ kind: "Token"; value: string }>
  | Readonly<{ kind: "ByteSequence"; value: Uint8Array }>
  | Readonly<{ kind: "Boolean"; value: boolean }>;

/** An ordered map: a repeated key keeps its first position and takes its last value. */
export type SfParameters = ReadonlyArray<readonly [string, SfBareItem]>;

export type SfItem = Readonly<{ kind: "Item"; value: SfBareItem; params: SfParameters }>;

export type SfInnerList = Readonly<{
  kind: "InnerList";
  items: ReadonlyArray<SfItem>;
  params: SfParameters;
}>;

export type SfMember = SfItem | SfInnerList;

/** An ordered map, as {@link SfParameters}. */
export type SfDictionary = ReadonlyArray<readonly [string, SfMember]>;

export type SfParseError = Readonly<{ kind: "InvalidStructuredField"; at: number }>;

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";
const isLcAlpha = (char: string | undefined): boolean =>
  char !== undefined && char >= "a" && char <= "z";
const isAlpha = (char: string | undefined): boolean =>
  isLcAlpha(char) || (char !== undefined && char >= "A" && char <= "Z");
const isKeyChar = (char: string | undefined): boolean =>
  isLcAlpha(char) || isDigit(char) || char === "_" || char === "-" || char === "." || char === "*";
const TCHAR_SYMBOLS = "!#$%&'*+-.^_`|~";
const isTokenChar = (char: string | undefined): boolean =>
  isAlpha(char) ||
  isDigit(char) ||
  (char !== undefined && TCHAR_SYMBOLS.includes(char)) ||
  char === ":" ||
  char === "/";
const isBase64Char = (char: string | undefined): boolean =>
  isAlpha(char) || isDigit(char) || char === "+" || char === "/" || char === "=";

class Failure extends Error {
  readonly at: number;

  constructor(at: number) {
    super("invalid structured field");
    this.at = at;
  }
}

/** A cursor over one field value; each method follows its algorithm in RFC 8941 section 4.2. */
class Parser {
  private at = 0;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
  }

  private peek(): string | undefined {
    return this.input[this.at];
  }

  private fail(): never {
    throw new Failure(this.at);
  }

  private skip(chars: string): void {
    while (this.peek() !== undefined && chars.includes(this.peek() ?? "")) {
      this.at += 1;
    }
  }

  done(): boolean {
    return this.at >= this.input.length;
  }

  dictionary(): SfDictionary {
    const members = new Map<string, SfMember>();
    while (!this.done()) {
      const key = this.key();
      let member: SfMember;
      if (this.peek() === "=") {
        this.at += 1;
        member = this.itemOrInnerList();
      } else {
        member = { kind: "Item", value: { kind: "Boolean", value: true }, params: this.params() };
      }
      members.set(key, member);
      this.skip(" \t");
      if (this.done()) {
        break;
      }
      if (this.peek() !== ",") {
        this.fail();
      }
      this.at += 1;
      this.skip(" \t");
      if (this.done()) {
        this.fail();
      }
    }
    return [...members];
  }

  private itemOrInnerList(): SfMember {
    return this.peek() === "(" ? this.innerList() : this.item();
  }

  private innerList(): SfInnerList {
    this.at += 1;
    const items: SfItem[] = [];
    while (!this.done()) {
      this.skip(" ");
      if (this.peek() === ")") {
        this.at += 1;
        return { kind: "InnerList", items, params: this.params() };
      }
      items.push(this.item());
      if (this.peek() !== " " && this.peek() !== ")") {
        this.fail();
      }
    }
    return this.fail();
  }

  private item(): SfItem {
    return { kind: "Item", value: this.bareItem(), params: this.params() };
  }

  private params(): SfParameters {
    const params = new Map<string, SfBareItem>();
    while (this.peek() === ";") {
      this.at += 1;
      this.skip(" ");
      const key = this.key();
      let value: SfBareItem = { kind: "Boolean", value: true };
      if (this.peek() === "=") {
        this.at += 1;
        value = this.bareItem();
      }
      params.set(key, value);
    }
    return [...params];
  }

  private key(): string {
    const first = this.peek();
    if (!isLcAlpha(first) && first !== "*") {
      this.fail();
    }
    const start = this.at;
    while (isKeyChar(this.peek())) {
      this.at += 1;
    }
    return this.input.slice(start, this.at);
  }

  private bareItem(): SfBareItem {
    const first = this.peek();
    if (first === "-" || isDigit(first)) {
      return this.number();
    }
    if (first === '"') {
      return this.string();
    }
    if (first === ":") {
      return this.byteSequence();
    }
    if (first === "?") {
      return this.boolean();
    }
    if (isAlpha(first) || first === "*") {
      return this.token();
    }
    return this.fail();
  }

  private number(): SfBareItem {
    const start = this.at;
    if (this.peek() === "-") {
      this.at += 1;
    }
    if (!isDigit(this.peek())) {
      this.fail();
    }
    let decimal = false;
    while (isDigit(this.peek()) || (!decimal && this.peek() === ".")) {
      if (this.peek() === ".") {
        const integerDigits = this.at - start - (this.input[start] === "-" ? 1 : 0);
        if (integerDigits > 12) {
          this.fail();
        }
        decimal = true;
      }
      this.at += 1;
      const length = this.at - start - (this.input[start] === "-" ? 1 : 0);
      if ((!decimal && length > 15) || (decimal && length > 16)) {
        this.fail();
      }
    }
    const text = this.input.slice(start, this.at);
    if (!decimal) {
      return { kind: "Integer", value: Number(text) };
    }
    const fraction = text.length - text.indexOf(".") - 1;
    if (fraction < 1 || fraction > 3) {
      this.fail();
    }
    return { kind: "Decimal", value: Number(text) };
  }

  private string(): SfBareItem {
    this.at += 1;
    let value = "";
    while (!this.done()) {
      const char = this.input[this.at] ?? "";
      this.at += 1;
      if (char === "\\") {
        const next = this.peek();
        if (next !== '"' && next !== "\\") {
          this.fail();
        }
        value += next;
        this.at += 1;
      } else if (char === '"') {
        return { kind: "String", value };
      } else if (char < " " || char > "~") {
        this.at -= 1;
        this.fail();
      } else {
        value += char;
      }
    }
    return this.fail();
  }

  private token(): SfBareItem {
    const start = this.at;
    this.at += 1;
    while (isTokenChar(this.peek())) {
      this.at += 1;
    }
    return { kind: "Token", value: this.input.slice(start, this.at) };
  }

  private byteSequence(): SfBareItem {
    this.at += 1;
    const start = this.at;
    while (isBase64Char(this.peek())) {
      this.at += 1;
    }
    if (this.peek() !== ":") {
      this.fail();
    }
    const encoded = this.input.slice(start, this.at);
    this.at += 1;
    try {
      return {
        kind: "ByteSequence",
        value: Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)),
      };
    } catch {
      return this.fail();
    }
  }

  private boolean(): SfBareItem {
    this.at += 1;
    const char = this.peek();
    if (char !== "0" && char !== "1") {
      this.fail();
    }
    this.at += 1;
    return { kind: "Boolean", value: char === "1" };
  }
}

/**
 * A dictionary field (RFC 8941 section 4.2.2), as received: a field sent on
 * several lines is read as the lines joined with ", ", which `Headers.get`
 * gives.
 */
export const parseSfDictionary = (field: string): Result<SfDictionary, SfParseError> => {
  // Index-based: a regex trim (`/^ +| +$/`) is quadratic on a long run of
  // interior spaces, and this field comes from an unauthenticated request.
  let start = 0;
  let end = field.length;
  while (start < end && field[start] === " ") {
    start += 1;
  }
  while (end > start && field[end - 1] === " ") {
    end -= 1;
  }
  try {
    return ok(new Parser(field.slice(start, end)).dictionary());
  } catch (error) {
    if (error instanceof Failure) {
      return err({ kind: "InvalidStructuredField", at: error.at });
    }
    throw error;
  }
};

/** A member of a parsed dictionary or parameter list, by key. */
export const sfLookup = <T>(
  entries: ReadonlyArray<readonly [string, T]>,
  key: string,
): T | undefined => entries.find(([name]) => name === key)?.[1];

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const serializeDecimal = (value: number): string => {
  const fixed = value.toFixed(3).replace(/0+$/, "");
  return fixed.endsWith(".") ? `${fixed}0` : fixed;
};

/** A bare item serialized as RFC 8941 section 4.1.3.1 does. */
export const serializeSfBareItem = (item: SfBareItem): string => {
  switch (item.kind) {
    case "Integer":
      return String(item.value);
    case "Decimal":
      return serializeDecimal(item.value);
    case "String":
      return `"${item.value.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
    case "Token":
      return item.value;
    case "ByteSequence":
      return `:${bytesToBase64(item.value)}:`;
    case "Boolean":
      return item.value ? "?1" : "?0";
  }
};

export const serializeSfParameters = (params: SfParameters): string =>
  params
    .map(([key, value]) =>
      value.kind === "Boolean" && value.value ? `;${key}` : `;${key}=${serializeSfBareItem(value)}`,
    )
    .join("");

export const serializeSfItem = (item: SfItem): string =>
  serializeSfBareItem(item.value) + serializeSfParameters(item.params);

export const serializeSfInnerList = (list: SfInnerList): string =>
  `(${list.items.map(serializeSfItem).join(" ")})${serializeSfParameters(list.params)}`;
