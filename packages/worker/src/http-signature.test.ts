import { describe, expect, it } from "vite-plus/test";
import {
  buildSigningString,
  parseSignatureHeader,
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
    JSON.parse(keys.privateKeyJwk),
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
          date: "Wed, 01 Jan 2026 00:00:00 GMT",
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
        date: "Wed, 01 Jan 2026 00:00:00 GMT",
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
