import { describe, expect, it } from "vite-plus/test";
import { isBlockedResolvedAddress, RemoteDnsPolicy } from "./remote-dns-policy";

describe("isBlockedResolvedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not-an-address",
  ])("blocks %s", (address) => {
    expect(isBlockedResolvedAddress(address)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
  ])("admits %s", (address) => {
    expect(isBlockedResolvedAddress(address)).toBe(false);
  });
});

describe("RemoteDnsPolicy.judge", () => {
  it("admits public answers only", () => {
    expect(RemoteDnsPolicy.judge(["8.8.8.8", "2606:4700:4700::1111"])).toEqual({ kind: "Public" });
  });

  it("refuses a host with any blocked answer", () => {
    expect(RemoteDnsPolicy.judge(["8.8.8.8", "127.0.0.1"])).toEqual({ kind: "BlockedAddress" });
  });

  it("reports no records", () => {
    expect(RemoteDnsPolicy.judge([])).toEqual({ kind: "NoRecords" });
  });
});
