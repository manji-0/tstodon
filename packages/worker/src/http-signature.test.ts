import { describe, expect, it } from "vitest";
import { buildSigningString, parseSignatureHeader } from "./http-signature";

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
