import { describe, expect, it } from "vite-plus/test";
import { Sensitive } from "@tstodon/core";
import {
  checkContentDigest,
  checkMessageSignatureStrength,
  contentDigestHeader,
  type MessageSignature,
  messageSignatureBase,
  parseMessageSignature,
  verifyMessageSignature,
} from "./http-message-signature";
import {
  checkSignatureStrength,
  parseRequestSignature,
  signFetchRequest,
  signInboxRequest,
  verifyInboxRequest,
  verifySignedFetch,
} from "./http-signature";

/** RFC 9421 B.1.1, test-key-rsa. */
const TEST_KEY_RSA_PUBLIC = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAhAKYdtoeoy8zcAcR874L
8cnZxKzAGwd7v36APp7Pv6Q2jdsPBRrwWEBnez6d0UDKDwGbc6nxfEXAy5mbhgaj
zrw3MOEt8uA5txSKobBpKDeBLOsdJKFqMGmXCQvEG7YemcxDTRPxAleIAgYYRjTS
d/QBwVW9OwNFhekro3RtlinV0a75jfZgkne/YiktSvLG34lw2zqXBDTC5NHROUqG
TlML4PlNZS5Ri2U4aCNx2rUPRcKIlE0PuKxI4T+HIaFpv8+rdV6eUgOrB2xeI1dS
FFn/nnv5OoZJEIB+VmuKn3DCUcCZSFlQPSXSfBDiUGhwOw76WuSSsf1D4b/vLoJ1
0wIDAQAB
-----END PUBLIC KEY-----`;

/** RFC 9421 B.1.1, test-key-rsa, as the JWK tstodon stores a private key in. */
const TEST_KEY_RSA_PRIVATE_JWK = Sensitive.of(
  JSON.stringify({
    kty: "RSA",
    n: "hAKYdtoeoy8zcAcR874L8cnZxKzAGwd7v36APp7Pv6Q2jdsPBRrwWEBnez6d0UDKDwGbc6nxfEXAy5mbhgajzrw3MOEt8uA5txSKobBpKDeBLOsdJKFqMGmXCQvEG7YemcxDTRPxAleIAgYYRjTSd_QBwVW9OwNFhekro3RtlinV0a75jfZgkne_YiktSvLG34lw2zqXBDTC5NHROUqGTlML4PlNZS5Ri2U4aCNx2rUPRcKIlE0PuKxI4T-HIaFpv8-rdV6eUgOrB2xeI1dSFFn_nnv5OoZJEIB-VmuKn3DCUcCZSFlQPSXSfBDiUGhwOw76WuSSsf1D4b_vLoJ10w",
    e: "AQAB",
    d: "b8lm5JZ2hUduLnq-OAKCSODeWQ7Uqs7eet2bqeuAD0_2po-PG4qhZoo7VwFCUTWlJan9wqdxiAPlbEQKkCdFRcbakbjN2TMJjMCHWL5zfgvqhmgeyKsrqg1wSce97J1_Mkvn3fh6CbqnwNb6bVFDvTJS3i5FzRhKiv6rUsYm8ZAdF4XRaYkFkeuHPl7rc-ruUTSAjC4GovxIxoDJFe0r4kbFmkiZOr40e8RZYK7T1IKrSvzfxx5AjnlK_OZOTCq0L7wBPbMW-IxmQpFCjpI-yuoi3FlZG3LaLNrBMXQF_lLZUDHs77q3fAGxDWwum2hKBfdBuUQtjlqwjQlgXPsskQ",
    p: "sqeUJmqXE3LP8tYoIjMIAKiTm9o6psPlc8CrLI9CH0UbuaA2JCOMcCNq8SyYbTqgnWlB9ZfcAm_cFpA8tYci9m5vYK8HNxQr-8FS3Qo8N9RJ8d0U5CswDzMYfRghAfUGwmlWj5hp1pQzAuhwbOXFtxKHVsMPhz1IBtF9Y8jvgqgYHLbmyiu1mw",
    q: "vSlgXQbvHzWmuUBFRHAejRh_naQTDV3GnH4lcRHuFBFZCSLn82xQS2_7xFOqfabqq17kNcvKfzdvWpGxxJ2cILAq0pZS6DmrZlvBU4IkK2ZHCac_XfWVZFh-PrsH_EnVkDpfcYR_iw1F40C1q5w8R6WBHaew3SAp",
    dp: "aiodZsrWpi8HFfZfeRs8OS_0L5x6WBl3Y9btoZgsIeruc9uZ8NXTIdxaM6FdnyNEyOYA1VH94tDYR-xEt1br1ud_dkPslLV_Aac7d7EaYc7cdkb7oC9t6sphVg0dqE0UTDlOwBxBYMtGmQbJsFzGpmjzVgKqWqJ3B947li2U7t63HXEvKprY2w",
    dq: "b0DzpSMb5p42dcQgOTU8Mr4S6JOEhRr_YjErMkpaXUEqvZ3jEB9HRmcRi5Gtt4NBiBMiY6V9br8a5gjEpiAQoIUcWokBMAYjEeurU8M6JLBd3YaZVVjISaFmdtynwLFoQxCh6_EC1rSywwrfDpSwO29S9i8Xbaap",
    qi: "PkbARLOwU_LcZrQy9mmfcPoQlAuCyeu1Q9nH7PYSnbHTFzmiud4Hl8bIXU9a0_58blDoOl3PctF-b4rAEJYUpCODu5PFyN6uEFYRg-YQwpjBMkXk8Eb39128ctARB40Lx8caDhRdTyaEedIG3cQDXSpAl9EOzXkzfx4bZxjAHU9mkMdJwOcMDQ",
  }),
);

/** RFC 9421 B.1.4, test-key-ed25519. */
const TEST_KEY_ED25519_PUBLIC = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=
-----END PUBLIC KEY-----`;

const spki = (pem: string): Uint8Array =>
  Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----|\s/g, "")), (char) => char.charCodeAt(0));

const rsaPublicKey = (): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "spki",
    spki(TEST_KEY_RSA_PUBLIC),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

const ed25519PublicKey = (): Promise<CryptoKey> =>
  crypto.subtle.importKey("spki", spki(TEST_KEY_ED25519_PUBLIC), { name: "Ed25519" }, false, [
    "verify",
  ]);

const signatureOf = (request: Request): MessageSignature => {
  const parsed = parseMessageSignature(
    request.headers.get("Signature-Input") ?? "",
    request.headers.get("Signature") ?? "",
  );
  if (parsed.isErr()) {
    throw new Error(`signature did not parse: ${parsed.error.kind}`);
  }
  return parsed.value;
};

/** RFC 9421 B.2's test-request. */
const testRequest = (headers: Record<string, string>): Request =>
  new Request("https://example.com/foo?param=Value&Pet=dog", {
    method: "POST",
    headers: {
      Host: "example.com",
      Date: "Tue, 20 Apr 2021 02:07:55 GMT",
      "Content-Type": "application/json",
      "Content-Digest":
        "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
      "Content-Length": "18",
      ...headers,
    },
    body: '{"hello": "world"}',
  });

describe("RFC 9421 Appendix B vectors", () => {
  it("B.2.6: an ed25519 signature over a request verifies, with the RFC's signature base", async () => {
    const request = testRequest({
      "Signature-Input":
        'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      Signature:
        "sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:",
    });
    const signature = signatureOf(request);
    expect(messageSignatureBase(request, signature.input)).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join("\n"),
    );
    expect(await verifyMessageSignature(request, signature, await ed25519PublicKey())).toBe(true);
    // Mastodon takes no signature that leaves out `@target-uri` (or `content-digest` on a POST).
    expect(checkMessageSignatureStrength(request, signature, 1618884473_000)).toEqual({
      kind: "TargetNotSigned",
    });
  });

  const transform = (
    method: string,
    path: string,
    headers: ReadonlyArray<readonly [string, string]>,
  ): Request => {
    const sent = new Headers();
    for (const [name, value] of headers) {
      sent.append(name, value);
    }
    sent.set(
      "Signature-Input",
      'transform=("@method" "@path" "@authority" "accept");created=1618884473;keyid="test-key-ed25519"',
    );
    sent.set(
      "Signature",
      "transform=:ZT1kooQsEHpZ0I1IjCqtQppOmIqlJPeo7DHR3SoMn0s5JZ1eRGS0A+vyYP9t/LXlh5QMFFQ6cpLt2m0pmj3NDA==:",
    );
    // `@authority` is the target URI's, and a client sends `Host` as its authority.
    const host = headers.find(([name]) => name === "Host")?.[1] ?? "example.org";
    return new Request(`https://${host}${path}`, { method, headers: sent });
  };

  it.each([
    [
      "as signed",
      transform("GET", "/demo?name1=Value1&Name2=value2", [
        ["Host", "example.org"],
        ["Date", "Fri, 15 Jul 2022 14:24:55 GMT"],
        ["Accept", "application/json"],
        ["Accept", "*/*"],
      ]),
    ],
    [
      "with a header and a query parameter added",
      transform("GET", "/demo?name1=Value1&Name2=value2&param=added", [
        ["Host", "example.org"],
        ["Date", "Fri, 15 Jul 2022 14:24:55 GMT"],
        ["Accept", "application/json"],
        ["Accept", "*/*"],
        ["Accept-Language", "en-US,en;q=0.5"],
      ]),
    ],
    [
      "with Date removed, Referer added and Accept collapsed",
      transform("GET", "/demo?name1=Value1&Name2=value2", [
        ["Host", "example.org"],
        ["Referer", "https://developer.example.org/demo"],
        ["Accept", "application/json, */*"],
      ]),
    ],
  ])("B.4: a transformed request still verifies (%s)", async (_, request) => {
    expect(
      await verifyMessageSignature(request, signatureOf(request), await ed25519PublicKey()),
    ).toBe(true);
  });

  it.each([
    [
      "the method and authority changed",
      transform("POST", "/demo?name1=Value1&Name2=value2", [
        ["Host", "example.com"],
        ["Date", "Fri, 15 Jul 2022 14:24:55 GMT"],
        ["Accept", "application/json"],
        ["Accept", "*/*"],
      ]),
    ],
    [
      "the Accept lines swapped",
      transform("GET", "/demo?name1=Value1&Name2=value2", [
        ["Host", "example.org"],
        ["Date", "Fri, 15 Jul 2022 14:24:55 GMT"],
        ["Accept", "*/*"],
        ["Accept", "application/json"],
      ]),
    ],
  ])("B.4: a transformed request no longer verifies (%s)", async (_, request) => {
    expect(
      await verifyMessageSignature(request, signatureOf(request), await ed25519PublicKey()),
    ).toBe(false);
  });

  const proxySigned = (): Request =>
    new Request("https://origin.host.internal.example/foo?param=Value&Pet=dog", {
      method: "POST",
      headers: {
        Host: "origin.host.internal.example",
        Date: "Tue, 20 Apr 2021 02:07:56 GMT",
        "Content-Type": "application/json",
        "Content-Length": "18",
        Forwarded: "for=192.0.2.123;host=example.com;proto=https",
        "Content-Digest":
          "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
        "Signature-Input":
          'sig1=("@method" "@authority" "@path" "content-digest" "content-type" "content-length");created=1618884475;keyid="test-key-ecc-p256", proxy_sig=("@method" "@authority" "@path" "content-digest" "content-type" "content-length" "forwarded");created=1618884480;keyid="test-key-rsa";alg="rsa-v1_5-sha256";expires=1618884540',
        Signature:
          "sig1=:X5spyd6CFnAG5QnDyHfqoSNICd+BUP4LYMz2Q0JXlb//4Ijpzp+kve2w4NIyqeAuM7jTDX+sNalzA8ESSaHD3A==:, proxy_sig=:S6ZzPXSdAMOPjN/6KXfXWNO/f7V6cHm7BXYUh3YD/fRad4BCaRZxP+JH+8XY1I6+8Cy+CM5g92iHgxtRPz+MjniOaYmdkDcnL9cCpXJleXsOckpURl49GwiyUpZ10KHgOEe11sx3G2gxI8S0jnxQB+Pu68U9vVcasqOWAEObtNKKZd8tSFu7LB5YAv0RAGhB8tmpv7sFnIm9y+7X5kXQfi8NMaZaA8i2ZHwpBdg7a6CMfwnnrtflzvZdXAsD3LH2TwevU+/PBPv0B6NMNk93wUs/vfJvye+YuI87HU38lZHowtznbLVdp770I6VHR6WfgS9ddzirrswsE1w5o0LV/g==:",
      },
      body: '{"hello": "world"}',
    });

  it("4.3: a request with two signatures is refused, as linzer refuses one Mastodon names no label for", () => {
    expect(parseRequestSignature(proxySigned().headers)._unsafeUnwrapErr()).toEqual({
      kind: "MultipleSignatures",
    });
  });

  it("4.3: the proxy's rsa-v1_5-sha256 signature verifies alone, with the RFC's signature base", async () => {
    const request = proxySigned();
    const input = (request.headers.get("Signature-Input") ?? "").split(", ")[1] ?? "";
    const signature = parseMessageSignature(
      input,
      request.headers.get("Signature") ?? "",
    )._unsafeUnwrap();
    expect(signature.label).toBe("proxy_sig");
    expect(messageSignatureBase(request, signature.input)).toBe(
      [
        '"@method": POST',
        '"@authority": origin.host.internal.example',
        '"@path": /foo',
        '"content-digest": sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
        '"content-type": application/json',
        '"content-length": 18',
        '"forwarded": for=192.0.2.123;host=example.com;proto=https',
        '"@signature-params": ("@method" "@authority" "@path" "content-digest" "content-type" "content-length" "forwarded");created=1618884480;keyid="test-key-rsa";alg="rsa-v1_5-sha256";expires=1618884540',
      ].join("\n"),
    );
    expect(await verifyMessageSignature(request, signature, await rsaPublicKey())).toBe(true);
    // Its `expires` has passed by the next minute: `linzer` refuses it, without Mastodon's skew.
    expect(checkMessageSignatureStrength(request, signature, 1618884540_000)).toEqual({
      kind: "SignatureExpired",
      detail: "past",
    });
  });
});

/**
 * Requests Mastodon v4.7.5 sends when it double-knocks, made and verified
 * with its `linzer` 0.8.0 by `test/rfc9421-vectors.rb` (RFC 9421's test keys,
 * created 2026-01-01T00:00:00Z).
 */
const MASTODON_VECTORS = {
  rsaPost: {
    url: "https://tstodon.example/inbox",
    body: '{"type":"Follow"}',
    keyId: "https://mastodon.example/users/alice#main-key",
    contentDigest: "sha-256=:GYwYnH3BiO6aICFt0ThC5bUIJ4byvqdpWtR8m5fNkww=:",
    signatureInput:
      'sig1=("@method" "@target-uri" "content-digest");created=1767225600;keyid="https://mastodon.example/users/alice#main-key"',
    signature:
      "sig1=:Wt5zZ8j4iFGWTU/OdFsiejVjstOW9CHv0oS84eP54gki1XfF/E3RWZbsd/qXBrwRyhnImbvStXPMdDwyF+7kEDxiFR4kGvFJkDs0jGH309s0CWr0KIj/gYTsFre3xcL+SRLZaOgmcI6yZsQEMIyLWsPEm3hdSFODaY6aQpnr+2Sx3kr8JM8MAKNInmg8QGJhY4W2eLMWasNRbudzAgBcWPCgl5SZtFh5e2l5Ts9gIrHwOB0/L/dcnI4D9sidOB6Ec3Kr1aTL0r9nosCFw2+4V+pLpm0m9HdSeAGmq1rcE+Ly6/yraHjZ8D8DFJH+eDG7YDQcFqPF4yhyJ45JsKv3VA==:",
  },
  rsaGet: {
    url: "https://tstodon.example/users/bob/outbox?page=true",
    keyId: "https://mastodon.example/actor#main-key",
    signatureInput:
      'sig1=("@method" "@target-uri");created=1767225600;keyid="https://mastodon.example/actor#main-key"',
    signature:
      "sig1=:JLZV8P852jWi2/dvFSqBThRbPqL86v2gnBzXJ8Z5W6keFMexhwFNUVlXm09FoJgUvd4IUBC40jiJpmoMACgya/u8fJMGOXcnw17RVXeGdq1+q5d3rj+JOPXXnugqSxPoUCqwVMix3Vjdf9jQiEJJx6jAPQ/mlJmbK8bL6MAXo0VfggiwPxbWdnrG3t0+yqe/Ob7mK09PMZYcQZpJuEf5TS/PK1/A4TByNG6J7djqXJqORFzCvB9ATt32ZdveF5dIfpkU7jBkRhOP3N9aiZMSaar6gS0lVb3JYGG6xeMgS4dmYChIHnPur47QkoC6Tzps80k0ZnPU39JH3TMDqOaVkw==:",
  },
  ed25519Post: {
    url: "https://tstodon.example/users/bob/inbox",
    body: '{"type":"Like"}',
    keyId: "https://mastodon.example/users/alice#ed25519-key",
    contentDigest: "sha-256=:fQLcyuiC5b53id2wfhThCI+LFjFoCGXZfRwgMiR7Fp0=:",
    signatureInput:
      'sig1=("@method" "@target-uri" "content-digest");created=1767225600;keyid="https://mastodon.example/users/alice#ed25519-key"',
    signature:
      "sig1=:kp6Ojw1GM4j1dur9cT8aUVMQ7PVlHyqRJzuptB5YKpxmbwgBf5jPZxUgurUtP7hRxylZBfO+1IFyBr6AX9syAA==:",
  },
} as const;

const CREATED = new Date("2026-01-01T00:00:00Z");

const mastodonPost = (
  vector: typeof MASTODON_VECTORS.rsaPost | typeof MASTODON_VECTORS.ed25519Post,
  headers: Record<string, string> = {},
): Request =>
  new Request(vector.url, {
    method: "POST",
    headers: {
      Host: new URL(vector.url).host,
      Date: CREATED.toUTCString(),
      "Content-Type": "application/activity+json",
      "Content-Digest": vector.contentDigest,
      "Signature-Input": vector.signatureInput,
      Signature: vector.signature,
      ...headers,
    },
    body: vector.body,
  });

const mastodonGet = (headers: Record<string, string> = {}): Request =>
  new Request(MASTODON_VECTORS.rsaGet.url, {
    headers: {
      Date: CREATED.toUTCString(),
      Accept: "application/activity+json",
      "Signature-Input": MASTODON_VECTORS.rsaGet.signatureInput,
      Signature: MASTODON_VECTORS.rsaGet.signature,
      ...headers,
    },
  });

const rsaKey = { kind: "Rsa", publicKeyPem: TEST_KEY_RSA_PUBLIC } as const;
const ed25519Key = { kind: "Ed25519", publicKeyPem: TEST_KEY_ED25519_PUBLIC } as const;

describe("RFC 9421 signatures as Mastodon sends them", () => {
  it("verifies a delivery Mastodon signed with an RSA key", async () => {
    const request = mastodonPost(MASTODON_VECTORS.rsaPost);
    const parsed = parseRequestSignature(request.headers)._unsafeUnwrap();
    expect(parsed).toMatchObject({
      kind: "MessageSignature",
      keyId: MASTODON_VECTORS.rsaPost.keyId,
      label: "sig1",
      created: 1767225600,
      expires: undefined,
    });
    expect(checkSignatureStrength(request, parsed, CREATED.getTime())).toBeUndefined();
    const body = MASTODON_VECTORS.rsaPost.body;
    expect(await verifyInboxRequestAt(request, rsaKey, body)).toBe(true);
  });

  it("verifies a delivery Mastodon signed with an Ed25519 key", async () => {
    const request = mastodonPost(MASTODON_VECTORS.ed25519Post);
    expect(await verifyInboxRequestAt(request, ed25519Key, MASTODON_VECTORS.ed25519Post.body)).toBe(
      true,
    );
    // The same key cannot pass for an RSA key, nor RSA's signature for Ed25519.
    expect(await verifyInboxRequestAt(request, rsaKey, MASTODON_VECTORS.ed25519Post.body)).toBe(
      false,
    );
    const rsa = mastodonPost(MASTODON_VECTORS.rsaPost);
    expect(await verifyInboxRequestAt(rsa, ed25519Key, MASTODON_VECTORS.rsaPost.body)).toBe(false);
  });

  it("verifies a signed GET Mastodon sent, with its query in @target-uri", async () => {
    const request = mastodonGet();
    const parsed = parseRequestSignature(request.headers)._unsafeUnwrap();
    expect(await verifySignedFetchAt(request, parsed, rsaKey)).toBe(true);
    const elsewhere = new Request("https://tstodon.example/users/bob/outbox?page=false", request);
    expect(await verifySignedFetchAt(elsewhere, parsed, rsaKey)).toBe(false);
  });

  it("verifies behind a TLS-terminating proxy that says https in X-Forwarded-Proto", async () => {
    const proxied = new Request(
      MASTODON_VECTORS.rsaGet.url.replace("https:", "http:"),
      mastodonGet(),
    );
    const parsed = parseRequestSignature(proxied.headers)._unsafeUnwrap();
    expect(await verifySignedFetchAt(proxied, parsed, rsaKey)).toBe(false);
    proxied.headers.set("X-Forwarded-Proto", "https");
    expect(await verifySignedFetchAt(proxied, parsed, rsaKey)).toBe(true);
  });

  it("refuses a body other than the one Content-Digest names, and a tampered digest", async () => {
    const request = mastodonPost(MASTODON_VECTORS.rsaPost);
    expect(await verifyInboxRequestAt(request, rsaKey, '{"type":"Block"}')).toBe(false);
    const forged = mastodonPost(MASTODON_VECTORS.rsaPost, {
      "Content-Digest": await contentDigestHeader('{"type":"Block"}'),
    });
    expect(await verifyInboxRequestAt(forged, rsaKey, '{"type":"Block"}')).toBe(false);
  });

  it("is what tstodon sends when it double-knocks, byte for byte", async () => {
    const post = MASTODON_VECTORS.rsaPost;
    const headers = (
      await signInboxRequest(
        new URL(post.url),
        TEST_KEY_RSA_PRIVATE_JWK,
        post.keyId,
        post.body,
        CREATED,
        "MessageSignature",
      )
    )._unsafeUnwrap();
    expect(headers.get("Content-Digest")).toBe(post.contentDigest);
    expect(headers.get("Signature-Input")).toBe(post.signatureInput);
    expect(headers.get("Signature")).toBe(post.signature);
    expect(headers.get("Digest")).toBeNull();

    const get = MASTODON_VECTORS.rsaGet;
    const fetchHeaders = (
      await signFetchRequest(
        new URL(get.url),
        TEST_KEY_RSA_PRIVATE_JWK,
        get.keyId,
        "application/activity+json",
        CREATED,
        "MessageSignature",
      )
    )._unsafeUnwrap();
    expect(fetchHeaders).toEqual({
      Date: CREATED.toUTCString(),
      "Signature-Input": get.signatureInput,
      Signature: get.signature,
    });
  });
});

const verifyInboxRequestAt = async (
  request: Request,
  key: typeof rsaKey | typeof ed25519Key,
  body: string,
): Promise<boolean> => withNow(CREATED.getTime(), () => verifyInboxRequest(request, key, body));

const verifySignedFetchAt = async (
  request: Request,
  parsed: Parameters<typeof verifySignedFetch>[1],
  key: typeof rsaKey,
): Promise<boolean> => withNow(CREATED.getTime(), () => verifySignedFetch(request, parsed, key));

const withNow = async <T>(now: number, run: () => Promise<T>): Promise<T> => {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
};

describe("checkMessageSignatureStrength", () => {
  const request = mastodonPost(MASTODON_VECTORS.rsaPost);
  const created = 1767225600;
  const at = (seconds: number): number => (created + seconds) * 1000;
  const withParams = (params: string, components = '"@method" "@target-uri" "content-digest"') =>
    signatureOf(
      new Request(request.url, {
        method: "POST",
        headers: { "Signature-Input": `sig1=(${components})${params}`, Signature: "sig1=:AA==:" },
      }),
    );

  it("takes a signature without expires for 5 minutes and an hour of skew", () => {
    const signature = withParams(`;created=${created};keyid="k"`);
    expect(checkMessageSignatureStrength(request, signature, at(65 * 60))).toBeUndefined();
    expect(checkMessageSignatureStrength(request, signature, at(65 * 60 + 1))).toEqual({
      kind: "SignatureExpired",
      detail: "past",
    });
    expect(checkMessageSignatureStrength(request, signature, at(-60 * 60))).toBeUndefined();
    expect(checkMessageSignatureStrength(request, signature, at(-60 * 60 - 1))).toEqual({
      kind: "SignatureExpired",
      detail: "future",
    });
  });

  it("takes expires as linzer does, without skew, and at most 12 hours (and the skew) after created", () => {
    const shortLived = withParams(`;created=${created};keyid="k";expires=${created + 60}`);
    expect(checkMessageSignatureStrength(request, shortLived, at(59))).toBeUndefined();
    expect(checkMessageSignatureStrength(request, shortLived, at(60))).toEqual({
      kind: "SignatureExpired",
      detail: "past",
    });
    const longLived = withParams(`;created=${created};keyid="k";expires=${created + 86400}`);
    expect(checkMessageSignatureStrength(request, longLived, at(13 * 3600))).toBeUndefined();
    expect(checkMessageSignatureStrength(request, longLived, at(13 * 3600 + 1))).toEqual({
      kind: "SignatureExpired",
      detail: "past",
    });
  });

  it("asks for @method and @target-uri, and content-digest on a POST", () => {
    const params = `;created=${created};keyid="k"`;
    expect(
      checkMessageSignatureStrength(
        request,
        withParams(params, '"@method" "content-digest"'),
        at(0),
      ),
    ).toEqual({ kind: "TargetNotSigned" });
    expect(
      checkMessageSignatureStrength(request, withParams(params, '"@method" "@target-uri"'), at(0)),
    ).toEqual({ kind: "DigestNotSigned" });
    expect(
      checkMessageSignatureStrength(
        request,
        withParams(params, '"@method" "@target-uri" "content-digest";sf'),
        at(0),
      ),
    ).toEqual({ kind: "DigestNotSigned" });
    const get = new Request(request.url);
    expect(
      checkMessageSignatureStrength(get, withParams(params, '"@method" "@target-uri"'), at(0)),
    ).toBeUndefined();
  });
});

describe("parseMessageSignature", () => {
  const input = '("@method" "@target-uri");created=1767225600;keyid="k"';
  it.each([
    ["an input that is not a dictionary", "sig1=(", "sig1=:AA==:", "MalformedSignatureInput"],
    ["an empty input", "", "sig1=:AA==:", "MalformedSignatureInput"],
    [
      "components that are not an inner list",
      'sig1="@method"',
      "sig1=:AA==:",
      "MalformedSignatureInput",
    ],
    [
      "a component that is not a string",
      'sig1=(date);created=1;keyid="k"',
      "sig1=:AA==:",
      "MalformedSignatureInput",
    ],
    ["two signatures", `a=${input}, b=${input}`, "a=:AA==:, b=:AA==:", "MultipleSignatures"],
    ["no keyid", 'sig1=("@method");created=1', "sig1=:AA==:", "MissingParameters"],
    ["an empty keyid", 'sig1=("@method");created=1;keyid=""', "sig1=:AA==:", "MissingParameters"],
    ["no created", 'sig1=("@method");keyid="k"', "sig1=:AA==:", "MissingParameters"],
    [
      "a decimal created",
      'sig1=("@method");created=1.5;keyid="k"',
      "sig1=:AA==:",
      "MissingParameters",
    ],
    [
      "a string expires",
      'sig1=("@method");created=1;keyid="k";expires="2"',
      "sig1=:AA==:",
      "MissingParameters",
    ],
    ["no signature under the label", `sig1=${input}`, "sig2=:AA==:", "MalformedSignature"],
    [
      "a signature that is not a byte sequence",
      `sig1=${input}`,
      'sig1="AA=="',
      "MalformedSignature",
    ],
  ])("refuses %s", (_, signatureInput, signature, kind) => {
    expect(parseMessageSignature(signatureInput, signature)._unsafeUnwrapErr()).toEqual({ kind });
  });
});

describe("messageSignatureBase", () => {
  const request = new Request("https://tstodon.example/users/bob?page=true", {
    headers: { Accept: "  application/activity+json\t" },
  });
  const base = (components: string): string | undefined =>
    messageSignatureBase(
      request,
      signatureOf(
        new Request(request.url, {
          headers: {
            "Signature-Input": `sig1=(${components});created=1;keyid="k"`,
            Signature: "sig1=:AA==:",
          },
        }),
      ).input,
    );

  it("derives each request component, and trims a field's value", () => {
    expect(
      base(
        '"@method" "@target-uri" "@authority" "@scheme" "@request-target" "@path" "@query" "accept"',
      ),
    ).toBe(
      [
        '"@method": GET',
        '"@target-uri": https://tstodon.example/users/bob?page=true',
        '"@authority": tstodon.example',
        '"@scheme": https',
        '"@request-target": /users/bob?page=true',
        '"@path": /users/bob',
        '"@query": ?page=true',
        '"accept": application/activity+json',
        '"@signature-params": ("@method" "@target-uri" "@authority" "@scheme" "@request-target" "@path" "@query" "accept");created=1;keyid="k"',
      ].join("\n"),
    );
  });

  it.each([
    ["a field the request does not carry", '"content-digest"'],
    ["a repeated component", '"@method" "@method"'],
    ["@signature-params", '"@signature-params"'],
    ["@status, a response's", '"@status"'],
    ["a parameterized component", '"accept";sf'],
    ["@query-param", '"@query-param";name="page"'],
    ["a name that is no field name", '"not a field"'],
  ])("has none for %s", (_, components) => {
    expect(base(components)).toBeUndefined();
  });
});

describe("checkContentDigest", () => {
  it("compares the sha-256 member with the body's digest", async () => {
    const body = '{"type":"Follow"}';
    expect(await checkContentDigest(MASTODON_VECTORS.rsaPost.contentDigest, body)).toEqual({
      kind: "Match",
    });
    expect(
      await checkContentDigest(`sha-512=:AA==:, ${MASTODON_VECTORS.rsaPost.contentDigest}`, body),
    ).toEqual({ kind: "Match" });
    expect(await checkContentDigest(MASTODON_VECTORS.rsaPost.contentDigest, "{}")).toEqual({
      kind: "Mismatch",
    });
    expect(await checkContentDigest("sha-512=:AA==:", body)).toEqual({ kind: "Mismatch" });
    expect(await checkContentDigest(null, body)).toEqual({ kind: "Missing" });
    expect(
      await checkContentDigest("SHA-256=GYwYnH3BiO6aICFt0ThC5bUIJ4byvqdpWtR8m5fNkww=", body),
    ).toEqual({ kind: "Malformed" });
  });
});
