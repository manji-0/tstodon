import { describe, expect, it } from "vite-plus/test";
import {
  checkMessageSignatureStrength,
  type MessageSignature,
  messageSignatureBase,
  parseMessageSignature,
  verifyMessageSignature,
} from "./http-message-signature";
import {
  type ComponentCase,
  LINZER_COMPONENT_CASES,
  LINZER_MULTIPLE_SIGNATURES,
} from "./rfc9421-components.fixture";

// The fixture is the signature base Mastodon's `linzer` 0.8.0 builds for each
// request (scripts/generate-rfc9421-components-reference.mjs).

/** RFC 9421 B.1.1, test-key-rsa. */
const TEST_KEY_RSA_PUBLIC = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhAKYdtoeoy8zcAcR874L
8cnZxKzAGwd7v36APp7Pv6Q2jdsPBRrwWEBnez6d0UDKDwGbc6nxfEXAy5mbhgaj
zrw3MOEt8uA5txSKobBpKDeBLOsdJKFqMGmXCQvEG7YemcxDTRPxAleIAgYYRjTS
d/QBwVW9OwNFhekro3RtlinV0a75jfZgkne/YiktSvLG34lw2zqXBDTC5NHROUqG
TlML4PlNZS5Ri2U4aCNx2rUPRcKIlE0PuKxI4T+HIaFpv8+rdV6eUgOrB2xeI1dS
FFn/nnv5OoZJEIB+VmuKn3DCUcCZSFlQPSXSfBDiUGhwOw76WuSSsf1D4b/vLoJ1
0wIDAQAB`;

/** RFC 9421 B.1.2, test-key-rsa-pss. */
const TEST_KEY_RSA_PSS_PUBLIC = `MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr4tmm3r20Wd/PbqvP1s2
+QEtvpuRaV8Yq40gjUR8y2Rjxa6dpG2GXHbPfvMs8ct+Lh1GH45x28Rw3Ry53mm+
oAXjyQ86OnDkZ5N8lYbggD4O3w6M6pAvLkhk95AndTrifbIFPNU8PPMO7OyrFAHq
gDsznjPFmTOtCEcN2Z1FpWgchwuYLPL+Wokqltd11nqqzi+bJ9cvSKADYdUAAN5W
Utzdpiy6LbTgSxP7ociU4Tn0g5I6aDZJ7A8Lzo0KSyZYoA485mqcO0GVAdVw9lq4
aOT9v6d+nb4bnNkQVklLQ3fVAvJm+xdDOp9LCNCN48V2pnDOkFV6+U9nV5oyc6XI
2wIDAQAB`;

const bytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64.replace(/\s/g, "")), (char) => char.charCodeAt(0));

const rsaKey = (): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "spki",
    bytes(TEST_KEY_RSA_PUBLIC),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

const requestOf = (entry: ComponentCase, headers: ComponentCase["headers"] = {}): Request => {
  const sent = new Headers();
  for (const [name, value] of Object.entries({ ...entry.headers, ...headers })) {
    for (const line of typeof value === "string" ? [value] : value) {
      sent.append(name, line);
    }
  }
  return new Request(entry.url, { method: entry.method, headers: sent });
};

const signatureOf = (signatureInput: string, signature = "AA=="): MessageSignature =>
  parseMessageSignature(`sig1=${signatureInput}`, `sig1=:${signature}:`)._unsafeUnwrap();

/**
 * Where `linzer` reads a query that Rack nests (`a[b]`), tstodon reads no
 * `@query-param` at all: refused here, though Mastodon takes it.
 */
const REFUSED_HERE = new Set(["query-param beside a nested name"]);

describe("covered components with parameters, as Mastodon's linzer derives them", () => {
  it.each(LINZER_COMPONENT_CASES.map((entry) => [entry.name, entry] as const))(
    "%s",
    async (_, entry) => {
      const request = requestOf(entry);
      const signature = signatureOf(entry.signatureInput, entry.signature);
      const base = messageSignatureBase(request, signature.input);
      if (REFUSED_HERE.has(entry.name)) {
        expect(entry.base).toEqual(expect.any(String));
        expect(base).toBeUndefined();
        return;
      }
      // A base `linzer` raises on (`raises`, a 500 in Mastodon) is refused here.
      expect(base).toBe(entry.base ?? undefined);
      expect(await verifyMessageSignature(request, signature, await rsaKey())).toBe(
        entry.signature !== undefined,
      );
    },
  );

  it("differs from Mastodon behind Puma only on a string member, which RFC 9421 serializes as a string", () => {
    // Puma hands Rack header values as binary strings, which `starry`
    // serializes as byte sequences: `a="x y"` comes out `a=:eCB5:`.
    expect(
      LINZER_COMPONENT_CASES.filter((entry) => entry.pumaBase !== undefined).map(
        (entry) => entry.name,
      ),
    ).toEqual(["sf on a string member", "key on a string member"]);
  });

  it("refuses a Signature-Input naming two signatures, where linzer raises unrescued", () => {
    expect(LINZER_MULTIPLE_SIGNATURES.raises).toBe(
      "Linzer::Error: Multiple signatures found but none was selected.",
    );
    expect(
      parseMessageSignature(
        LINZER_MULTIPLE_SIGNATURES.signatureInput,
        LINZER_MULTIPLE_SIGNATURES.signature,
      )._unsafeUnwrapErr(),
    ).toEqual({ kind: "MultipleSignatures" });
  });
});

describe("RFC 9421's own examples", () => {
  /** RFC 9421 B.2's test-request. */
  const testRequest = (url = "https://example.com/foo?param=Value&Pet=dog"): Request =>
    new Request(url, {
      method: "POST",
      headers: {
        Host: "example.com",
        "Content-Digest":
          "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
      },
    });

  const b22 = signatureOf(
    '("@authority" "content-digest" "@query-param";name="Pet");created=1618884473;keyid="test-key-rsa-pss";tag="header-example"',
    `LjbtqUbfmvjj5C5kr1Ugj4PmLYvx9wVjZvD9GsTT4F7GrcQEdJzgI9qHxICagShLRiLMlAJjtq6N4CDfKtjvuJyE5qH7KT8UCMkSowOB4+ECxCmT8rtAmj/0PIXxi0A0nxKyB09RNrCQibbUjsLS/2YyFYXEu4TRJQzRw1rLEuEfY17SARYhpTlaqwZVtR8NV7+4UKkjqpcAoFqWFQh62s7Cl+H2fjBSpqfZUJcsIk4N6wiKYd4je2U/lankenQ99PZfB4jY3I5rSV2DSBVkSFsURIjYErOs0tFTQosMTAoxk//0RoKUqiYY8Bh0aaUEb0rQl3/XaVe4bXTugEjHSw==`,
  );

  /** Whether B.2.2's `rsa-pss-sha512` signature verifies over the base derived from `request`. */
  const b22Verifies = async (request: Request): Promise<boolean> => {
    const base = messageSignatureBase(request, b22.input);
    if (base === undefined) {
      return false;
    }
    const key = await crypto.subtle.importKey(
      "spki",
      bytes(TEST_KEY_RSA_PSS_PUBLIC),
      { name: "RSA-PSS", hash: "SHA-512" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: 64 },
      key,
      b22.signature,
      new TextEncoder().encode(base),
    );
  };

  it("B.2.2: a named query parameter gives the RFC's base, which its signature verifies", async () => {
    expect(messageSignatureBase(testRequest(), b22.input)).toBe(
      [
        '"@authority": example.com',
        '"content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
        '"@query-param";name="Pet": dog',
        '"@signature-params": ("@authority" "content-digest" "@query-param";name="Pet");created=1618884473;keyid="test-key-rsa-pss";tag="header-example"',
      ].join("\n"),
    );
    expect(await b22Verifies(testRequest())).toBe(true);
  });

  it("B.2.2: a tampered query parameter, or one the query no longer has, does not verify", async () => {
    expect(await b22Verifies(testRequest("https://example.com/foo?param=Value&Pet=cat"))).toBe(
      false,
    );
    expect(await b22Verifies(testRequest("https://example.com/foo?param=Value&pet=dog"))).toBe(
      false,
    );
    // A parameter the signature does not name may change.
    expect(await b22Verifies(testRequest("https://example.com/foo?param=Other&Pet=dog"))).toBe(
      true,
    );
  });

  it("2.1.1, 2.1.2, 2.1.3 and 2.2.8: the component values RFC 9421 gives", () => {
    const base = (url: string, headers: Record<string, string>, components: string) =>
      messageSignatureBase(
        new Request(url, { headers }),
        signatureOf(`(${components});created=1;keyid="k"`).input,
      )
        ?.split("\n")
        .slice(0, -1);
    const dict = { "Example-Dict": " a=1, b=2;x=1;y=2, c=(a   b    c), d" };
    expect(
      base(
        "https://example.com/",
        { "Example-Dict": "  a=1,    b=2;x=1;y=2,   c=(a   b   c)" },
        '"example-dict" "example-dict";sf',
      ),
    ).toEqual([
      '"example-dict": a=1,    b=2;x=1;y=2,   c=(a   b   c)',
      '"example-dict";sf: a=1, b=2;x=1;y=2, c=(a b c)',
    ]);
    expect(
      base(
        "https://example.com/",
        dict,
        '"example-dict";key="a" "example-dict";key="d" "example-dict";key="b" "example-dict";key="c"',
      ),
    ).toEqual([
      '"example-dict";key="a": 1',
      '"example-dict";key="d": ?1',
      '"example-dict";key="b": 2;x=1;y=2',
      '"example-dict";key="c": (a b c)',
    ]);
    expect(
      base(
        "https://example.com/",
        { "Example-Header": "value, with, lots, of, commas" },
        '"example-header";bs',
      ),
    ).toEqual(['"example-header";bs: :dmFsdWUsIHdpdGgsIGxvdHMsIG9mLCBjb21tYXM=:']);
    expect(
      base(
        "https://www.example.com/path?param=value&foo=bar&baz=batman&qux=",
        {},
        '"@query-param";name="baz" "@query-param";name="qux" "@query-param";name="param"',
      ),
    ).toEqual([
      '"@query-param";name="baz": batman',
      '"@query-param";name="qux": ',
      '"@query-param";name="param": value',
    ]);
    expect(
      base(
        "https://www.example.com/parameters?var=this%20is%20a%20big%0Amultiline%20value&bar=with+plus+whitespace&fa%C3%A7ade%22%3A%20=something",
        {},
        '"@query-param";name="var" "@query-param";name="bar" "@query-param";name="fa%C3%A7ade%22%3A%20"',
      ),
    ).toEqual([
      '"@query-param";name="var": this%20is%20a%20big%0Amultiline%20value',
      '"@query-param";name="bar": with%20plus%20whitespace',
      '"@query-param";name="fa%C3%A7ade%22%3A%20": something',
    ]);
  });
});

describe("a signature over parameterized components, tampered with", () => {
  const ed25519 = async (): Promise<CryptoKeyPair> => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    if (!("privateKey" in pair)) {
      throw new Error("expected an Ed25519 key pair");
    }
    return pair;
  };

  /** Sign `lines` and the input for `components` with `key`, as a signer that derives them so would. */
  const signed = async (
    key: CryptoKeyPair,
    request: Request,
    components: string,
    lines: ReadonlyArray<string>,
  ): Promise<Request> => {
    const input = `(${components});created=1767225600;keyid="k"`;
    const base = [...lines, `"@signature-params": ${input}`].join("\n");
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, new TextEncoder().encode(base)),
    );
    const headers = new Headers(request.headers);
    headers.set("Signature-Input", `sig1=${input}`);
    headers.set("Signature", `sig1=:${btoa(String.fromCharCode(...signature))}:`);
    return new Request(request.url, { method: request.method, headers });
  };

  const verifies = async (key: CryptoKeyPair, request: Request): Promise<boolean> => {
    const signature = parseMessageSignature(
      request.headers.get("Signature-Input") ?? "",
      request.headers.get("Signature") ?? "",
    )._unsafeUnwrap();
    return verifyMessageSignature(request, signature, key.publicKey);
  };

  const withHeaders = (request: Request, headers: Record<string, string>): Request => {
    const sent = new Headers(request.headers);
    for (const [name, value] of Object.entries(headers)) {
      sent.set(name, value);
    }
    return new Request(request.url, { method: request.method, headers: sent });
  };

  const withInput = (request: Request, from: string, to: string): Request =>
    withHeaders(request, {
      "Signature-Input": (request.headers.get("Signature-Input") ?? "").replace(from, to),
    });

  const request = new Request("https://tstodon.example/inbox?page=2&min_id=7", {
    method: "POST",
    headers: { "Example-Dict": "a=1, b=2;x=1, c=(x y)" },
  });

  it("verifies untouched, and fails when a covered member's value or parameter changes", async () => {
    const key = await ed25519();
    const sent = await signed(
      key,
      request,
      '"example-dict";key="a" "example-dict";key="b" "@query-param";name="page"',
      [
        '"example-dict";key="a": 1',
        '"example-dict";key="b": 2;x=1',
        '"@query-param";name="page": 2',
      ],
    );
    expect(await verifies(key, sent)).toBe(true);
    // A member the signature does not cover may change; a covered one may not.
    expect(await verifies(key, withHeaders(sent, { "Example-Dict": "a=1, b=2;x=1, c=(z)" }))).toBe(
      true,
    );
    expect(
      await verifies(key, withHeaders(sent, { "Example-Dict": "a=9, b=2;x=1, c=(x y)" })),
    ).toBe(false);
    expect(
      await verifies(key, withHeaders(sent, { "Example-Dict": "a=1, b=2;x=2, c=(x y)" })),
    ).toBe(false);
    expect(await verifies(key, withHeaders(sent, { "Example-Dict": "a=1, b=2, c=(x y)" }))).toBe(
      false,
    );
    const query = new Request("https://tstodon.example/inbox?page=3&min_id=7", {
      method: "POST",
      headers: sent.headers,
    });
    expect(await verifies(key, query)).toBe(false);
  });

  it("fails when the input names another component, or the same one with other parameters", async () => {
    const key = await ed25519();
    const sent = await signed(key, request, '"example-dict";key="a"', [
      '"example-dict";key="a": 1',
    ]);
    expect(await verifies(key, sent)).toBe(true);
    expect(await verifies(key, withInput(sent, 'key="a"', 'key="b"'))).toBe(false);
    expect(
      await verifies(key, withInput(sent, '"example-dict";key="a"', '"example-dict";sf')),
    ).toBe(false);
    expect(await verifies(key, withInput(sent, ';key="a"', ';key="a";bs'))).toBe(false);
    expect(
      await verifies(key, withInput(sent, '"example-dict";key="a"', '"@query-param";name="a"')),
    ).toBe(false);
  });

  it("never verifies a component with ;req on a request, as a replayed response signature carries", async () => {
    const key = await ed25519();
    // The base a signer of a response to this request would have signed.
    const replayed = await signed(key, request, '"@method";req "@query-param";name="page";req', [
      '"@method";req: POST',
      '"@query-param";name="page";req: 2',
    ]);
    expect(await verifies(key, replayed)).toBe(false);
    const field = await signed(key, request, '"example-dict";req', [
      '"example-dict";req: a=1, b=2;x=1, c=(x y)',
    ]);
    expect(await verifies(key, field)).toBe(false);
  });

  it("is refused before any key lookup unless @method and @target-uri are covered without parameters", () => {
    const covered = (components: string) =>
      checkMessageSignatureStrength(
        new Request("https://tstodon.example/outbox"),
        signatureOf(`(${components});created=1767225600;keyid="k"`),
        1767225600_000,
      );
    expect(covered('"@method" "@target-uri"')).toBeUndefined();
    expect(covered('"@method";bs "@target-uri"')).toEqual({ kind: "TargetNotSigned" });
    expect(covered('"@method" "@target-uri";bs')).toEqual({ kind: "TargetNotSigned" });
  });
});
