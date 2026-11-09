import { describe, expect, it } from "vite-plus/test";
import { IpBlock, IpBlockSeverity, IpRange, type IpBlock as IpBlockValue } from "./ip-block";

const range = (raw: string): string => IpRange.parse(raw).unwrapOr("invalid");

const block = (raw: string, kind: IpBlockValue["severity"]["kind"], expiresAt?: string) => {
  const parsed = IpRange.parse(raw);
  if (parsed.isErr()) {
    throw new Error(raw);
  }
  return {
    id: raw,
    range: parsed.value,
    severity: { kind },
    comment: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiry: expiresAt
      ? { kind: "Expires" as const, at: expiresAt }
      : { kind: "Permanent" as const },
  } satisfies IpBlockValue;
};

describe("IpRange", () => {
  it("reads IPv4 addresses and ranges and clears host bits", () => {
    expect(range("203.0.113.7")).toBe("203.0.113.7/32");
    expect(range(" 10.1.2.3/8 ")).toBe("10.0.0.0/8");
    expect(range("0.0.0.0/0")).toBe("0.0.0.0/0");
  });

  it("reads IPv6 in its canonical compressed form", () => {
    expect(range("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1/128");
    expect(range("2001:db8:abcd:12::/48")).toBe("2001:db8:abcd::/48");
    expect(range("::")).toBe("::/128");
    expect(range("1:0:0:2:0:0:0:3")).toBe("1:0:0:2::3/128");
    expect(range("::ffff:192.0.2.0/120")).toBe("192.0.2.0/24");
  });

  it("refuses what is not a range", () => {
    for (const raw of [
      "",
      "example.com",
      "256.1.1.1",
      "1.2.3",
      "01.2.3.4",
      "1.2.3.4/33",
      "1.2.3.4/x",
      "1.2.3.4/8/8",
      "2001:db8::1::2",
      "2001:db8::/129",
      "1:2:3:4:5:6:7:8:9",
      "12345::",
    ]) {
      expect(IpRange.parse(raw).isErr(), raw).toBe(true);
    }
  });

  it("matches addresses of its family, IPv4-mapped IPv6 as IPv4", () => {
    const v4 = IpRange.parse("198.51.100.0/24")._unsafeUnwrap();
    expect(IpRange.contains(v4, "198.51.100.200")).toBe(true);
    expect(IpRange.contains(v4, "198.51.101.1")).toBe(false);
    expect(IpRange.contains(v4, "::ffff:198.51.100.9")).toBe(true);
    expect(IpRange.contains(v4, "not an ip")).toBe(false);
    const v6 = IpRange.parse("2001:db8::/32")._unsafeUnwrap();
    expect(IpRange.contains(v6, "2001:db8:1::5")).toBe(true);
    expect(IpRange.contains(v6, "2001:db9::5")).toBe(false);
    expect(IpRange.contains(v6, "198.51.100.1")).toBe(false);
  });
});

describe("IpBlock", () => {
  const now = Date.parse("2026-06-01T00:00:00.000Z");

  it("denies access only under no_access", () => {
    const list = IpBlock.compile([
      block("192.0.2.0/24", "NoAccess"),
      block("198.51.100.0/24", "SignUpBlock"),
    ]);
    expect(IpBlock.access(list, "192.0.2.10", now).kind).toBe("Denied");
    expect(IpBlock.access(list, "198.51.100.10", now).kind).toBe("Allowed");
    expect(IpBlock.access(list, "203.0.113.1", now).kind).toBe("Allowed");
  });

  it("decides a sign-up by the strictest matching block", () => {
    const list = IpBlock.compile([
      block("10.0.0.0/8", "SignUpRequiresApproval"),
      block("10.1.0.0/16", "SignUpBlock"),
    ]);
    expect(IpBlock.signUp(list, "10.2.0.1", now).kind).toBe("RequiresApproval");
    expect(IpBlock.signUp(list, "10.1.0.1", now).kind).toBe("Blocked");
    expect(IpBlock.signUp(list, "11.0.0.1", now).kind).toBe("Open");
  });

  it("ignores expired blocks", () => {
    const list = IpBlock.compile([block("192.0.2.0/24", "NoAccess", "2026-05-01T00:00:00.000Z")]);
    expect(IpBlock.access(list, "192.0.2.1", now).kind).toBe("Allowed");
    expect(IpBlock.expiryIn(60, now)).toEqual({
      kind: "Expires",
      at: "2026-06-01T00:01:00.000Z",
    });
    expect(IpBlock.expiryIn(undefined, now)).toEqual({ kind: "Permanent" });
  });

  it("maps severities to Mastodon's names", () => {
    expect(IpBlockSeverity.fromName("no_access")).toEqual({ kind: "NoAccess" });
    expect(IpBlockSeverity.fromName("toString")).toBeUndefined();
    expect(IpBlockSeverity.toName({ kind: "SignUpRequiresApproval" })).toBe(
      "sign_up_requires_approval",
    );
  });
});
