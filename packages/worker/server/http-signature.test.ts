import { describe, expect, it } from "vite-plus/test";
import {
  buildSigningString,
  checkSignatureStrength,
  parseSignatureHeader,
  SIGNATURE_CLOCK_SKEW_MS,
  SIGNATURE_MAX_AGE_MS,
  sha256DigestHeader,
  verifyInboxRequest,
  verifySignedFetch,
} from "./http-signature";
import { generateAccountKeys } from "./keys";

describe("parseSignatureHeader", () => {
  it("parses a standard Signature header", () => {
    const parsed = parseSignatureHeader(
      'keyId="https://example.com/users/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="abc123"',
    );
    expect(parsed).toEqual({
      keyId: "https://example.com/users/alice#main-key",
      algorithm: "rsa-sha256",
      headers: ["(request-target)", "host", "date", "digest"],
      signature: "abc123",
    });
  });

  it("defaults algorithm and rejects incomplete headers", () => {
    const parsed = parseSignatureHeader('keyId="kid",headers="host",signature="sig"');
    expect(parsed?.algorithm).toBe("rsa-sha256");
    expect(parseSignatureHeader('keyId="kid",headers="host"')).toBeUndefined();
    expect(parseSignatureHeader("not-a-signature")).toBeUndefined();
  });
});

describe("buildSigningString", () => {
  it("includes request-target and listed header values", () => {
    expect(
      buildSigningString("POST", "/inbox", ["(request-target)", "host", "date"], {
        host: "social.example",
        date: "Wed, 01 Jan 2026 00:00:00 GMT",
      }),
    ).toBe(
      "(request-target): post /inbox\nhost: social.example\ndate: Wed, 01 Jan 2026 00:00:00 GMT",
    );
  });
});

/** Sign `request` over `headers` the way a remote server does, returning the SPKI PEM. */
const signAs = async (
  request: Request,
  headers: ReadonlyArray<string>,
): Promise<Readonly<{ request: Request; publicKeyPem: string }>> => {
  const keys = await generateAccountKeys();
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(keys.privateKeyJwk.reveal()),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const url = new URL(request.url);
  const values = Object.fromEntries(
    headers
      .filter((name) => !name.startsWith("("))
      .map((name) => [name, request.headers.get(name) ?? ""]),
  );
  const signingString = buildSigningString(
    request.method,
    url.pathname + url.search,
    headers,
    values,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      privateKey,
      new TextEncoder().encode(signingString),
    ),
  );
  const publicKeyPem = keys.publicKeyPem;
  const signed = new Request(request);
  signed.headers.set(
    "Signature",
    `keyId="https://remote.example/users/bob#main-key",algorithm="rsa-sha256",headers="${headers.join(" ")}",signature="${btoa(String.fromCharCode(...signature))}"`,
  );
  return { request: signed, publicKeyPem };
};

describe("signature verification", () => {
  it("verifies a delivery that also signs content-type, as Mastodon does", async () => {
    const body = JSON.stringify({ type: "Like" });
    const { request, publicKeyPem } = await signAs(
      new Request("https://example.com/inbox", {
        method: "POST",
        body,
        headers: {
          host: "example.com",
          date: new Date().toUTCString(),
          digest: await sha256DigestHeader(body),
          "content-type": "application/activity+json",
        },
      }),
      ["(request-target)", "host", "date", "digest", "content-type"],
    );
    expect(await verifyInboxRequest(request, publicKeyPem, body)).toBe(true);

    const tampered = new Request(request, { body });
    tampered.headers.set("content-type", "text/plain");
    expect(await verifyInboxRequest(tampered, publicKeyPem, body)).toBe(false);
  });

  it("verifies a signed fetch only when it covers the request target", async () => {
    const fetch = new Request("https://example.com/users/alice/statuses/1", {
      headers: {
        host: "example.com",
        date: new Date().toUTCString(),
        accept: "application/activity+json",
      },
    });
    const covered = await signAs(fetch, ["(request-target)", "host", "date", "accept"]);
    const parsedCovered = parseSignatureHeader(covered.request.headers.get("Signature") ?? "");
    expect(parsedCovered).toBeDefined();
    if (!parsedCovered) {
      return;
    }
    expect(await verifySignedFetch(covered.request, parsedCovered, covered.publicKeyPem)).toBe(
      true,
    );

    const uncovered = await signAs(fetch, ["host", "date"]);
    const parsedUncovered = parseSignatureHeader(uncovered.request.headers.get("Signature") ?? "");
    if (!parsedUncovered) {
      throw new Error("signature header rejected");
    }
    expect(
      await verifySignedFetch(uncovered.request, parsedUncovered, uncovered.publicKeyPem),
    ).toBe(false);
  });
});

const HOUR_MS = 60 * 60 * 1000;

/** A delivery signed at `date` over `headers`, as a remote server sends it. */
const delivery = async (
  date: Date,
  headers: ReadonlyArray<string> = ["(request-target)", "host", "date", "digest"],
) => {
  const body = JSON.stringify({ type: "Like" });
  const signed = await signAs(
    new Request("https://example.com/inbox", {
      method: "POST",
      body,
      headers: {
        host: "example.com",
        date: date.toUTCString(),
        digest: await sha256DigestHeader(body),
      },
    }),
    headers,
  );
  const parsed = parseSignatureHeader(signed.request.headers.get("Signature") ?? "");
  if (!parsed) {
    throw new Error("signature header rejected");
  }
  return { ...signed, body, parsed };
};

/** A signed GET signed at `date` over `headers`. */
const signedGet = async (
  date: Date,
  headers: ReadonlyArray<string> = ["(request-target)", "host", "date", "accept"],
) => {
  const signed = await signAs(
    new Request("https://example.com/users/alice/statuses/1", {
      headers: {
        host: "example.com",
        date: date.toUTCString(),
        accept: "application/activity+json",
      },
    }),
    headers,
  );
  const parsed = parseSignatureHeader(signed.request.headers.get("Signature") ?? "");
  if (!parsed) {
    throw new Error("signature header rejected");
  }
  return { ...signed, parsed };
};

describe("signature freshness and strength (SIG-1)", () => {
  it("uses Mastodon's 12 hour window and 1 hour clock skew", () => {
    expect(SIGNATURE_MAX_AGE_MS).toBe(12 * HOUR_MS);
    expect(SIGNATURE_CLOCK_SKEW_MS).toBe(HOUR_MS);
  });

  it("accepts a fresh signature, and one a little old or a little ahead", async () => {
    for (const offset of [0, -11 * HOUR_MS, 30 * 60 * 1000]) {
      const fresh = await delivery(new Date(Date.now() + offset));
      expect(checkSignatureStrength(fresh.request, fresh.parsed)).toBeUndefined();
      expect(await verifyInboxRequest(fresh.request, fresh.publicKeyPem, fresh.body)).toBe(true);
      const get = await signedGet(new Date(Date.now() + offset));
      expect(await verifySignedFetch(get.request, get.parsed, get.publicKeyPem)).toBe(true);
    }
  });

  it("refuses a delivery and a signed GET signed 13 hours ago", async () => {
    const stale = await delivery(new Date(Date.now() - 13 * HOUR_MS));
    expect(checkSignatureStrength(stale.request, stale.parsed)).toEqual({
      kind: "SignatureExpired",
      detail: "past",
    });
    expect(await verifyInboxRequest(stale.request, stale.publicKeyPem, stale.body)).toBe(false);
    const get = await signedGet(new Date(Date.now() - 13 * HOUR_MS));
    expect(await verifySignedFetch(get.request, get.parsed, get.publicKeyPem)).toBe(false);
  });

  it("refuses a Date more than an hour ahead", async () => {
    const ahead = await delivery(new Date(Date.now() + 2 * HOUR_MS));
    expect(checkSignatureStrength(ahead.request, ahead.parsed)).toEqual({
      kind: "SignatureExpired",
      detail: "future",
    });
    expect(await verifyInboxRequest(ahead.request, ahead.publicKeyPem, ahead.body)).toBe(false);
    const get = await signedGet(new Date(Date.now() + 2 * HOUR_MS));
    expect(await verifySignedFetch(get.request, get.parsed, get.publicKeyPem)).toBe(false);
  });

  it("refuses a signature that does not cover date, even when it verifies", async () => {
    const undated = await delivery(new Date(), ["(request-target)", "host", "digest"]);
    expect(checkSignatureStrength(undated.request, undated.parsed)).toEqual({
      kind: "DateNotSigned",
    });
    expect(await verifyInboxRequest(undated.request, undated.publicKeyPem, undated.body)).toBe(
      false,
    );
    const get = await signedGet(new Date(), ["(request-target)", "host", "accept"]);
    expect(checkSignatureStrength(get.request, get.parsed)).toEqual({ kind: "DateNotSigned" });
    expect(await verifySignedFetch(get.request, get.parsed, get.publicKeyPem)).toBe(false);
  });

  it("refuses a POST whose signature does not cover digest, even when it verifies", async () => {
    const undigested = await delivery(new Date(), ["(request-target)", "host", "date"]);
    expect(checkSignatureStrength(undigested.request, undigested.parsed)).toEqual({
      kind: "DigestNotSigned",
    });
    expect(
      await verifyInboxRequest(undigested.request, undigested.publicKeyPem, undigested.body),
    ).toBe(false);
  });

  it("refuses a signed date that is missing or does not parse", async () => {
    const fresh = await delivery(new Date());
    const garbled = new Request(fresh.request, { body: fresh.body });
    garbled.headers.set("date", "yesterday");
    expect(checkSignatureStrength(garbled, fresh.parsed)).toEqual({
      kind: "SignatureExpired",
      detail: "invalid",
    });
    garbled.headers.delete("date");
    expect(checkSignatureStrength(garbled, fresh.parsed)).toEqual({
      kind: "SignatureExpired",
      detail: "invalid",
    });
  });
});
