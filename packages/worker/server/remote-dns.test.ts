import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  checkFederatedHost,
  fetchActivityJson,
  fetchWebfinger,
  unsignedFetch,
} from "./federated-fetch";
import {
  clearDnsVerdictCache,
  dohHostResolver,
  judgeHostDns,
  type HostResolver,
} from "./remote-dns";
import { parseInstanceIdentity } from "./runtime-config";

const identity = () => parseInstanceIdentity(env)._unsafeUnwrap();

const resolvingTo =
  (...addresses: string[]): HostResolver =>
  async () => ({ kind: "Resolved", addresses });

const failing: HostResolver = async () => ({ kind: "Failed" });

afterEach(() => {
  clearDnsVerdictCache();
  vi.unstubAllGlobals();
});

describe("judgeHostDns", () => {
  it("admits a host with public answers only", async () => {
    expect(await judgeHostDns("a.example", resolvingTo("8.8.8.8", "2606:4700::1111"))).toBe(
      "Admitted",
    );
  });

  it("refuses a public name that resolves to a private address", async () => {
    expect(await judgeHostDns("rebind.example", resolvingTo("8.8.8.8", "10.0.0.5"))).toBe(
      "Refused",
    );
    expect(await judgeHostDns("rebind6.example", resolvingTo("fd00::1"))).toBe("Refused");
    expect(await judgeHostDns("mapped.example", resolvingTo("::ffff:127.0.0.1"))).toBe("Refused");
  });

  it("refuses a host with no records, and does not cache it", async () => {
    const resolver = vi.fn<HostResolver>(async () => ({ kind: "Resolved", addresses: [] }));
    expect(await judgeHostDns("empty.example", resolver)).toBe("Refused");
    expect(await judgeHostDns("empty.example", resolver)).toBe("Refused");
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("fails closed, as unavailable, when the lookup fails, and does not cache it", async () => {
    expect(await judgeHostDns("down.example", failing)).toBe("Unavailable");
    expect(await judgeHostDns("down.example", resolvingTo("8.8.8.8"))).toBe("Admitted");
  });

  it("caches verdicts per isolate until the TTL ends", async () => {
    const resolver = vi.fn(resolvingTo("8.8.8.8"));
    let now = 1_000;
    const clock = () => now;
    await judgeHostDns("Cached.Example.", resolver, clock);
    await judgeHostDns("cached.example", resolver, clock);
    expect(resolver).toHaveBeenCalledTimes(1);
    now += 61_000;
    await judgeHostDns("cached.example", resolver, clock);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("caches a refusal too", async () => {
    const resolver = vi.fn(resolvingTo("127.0.0.1"));
    await judgeHostDns("deny.example", resolver);
    await judgeHostDns("deny.example", resolver);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});

describe("dohHostResolver", () => {
  const answer = (status: number, ...data: string[]) =>
    new Response(JSON.stringify({ Status: status, Answer: data.map((d) => ({ data: d })) }));

  it("merges A and AAAA answers and ignores CNAME names", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      seen.push(input);
      return input.includes("type=AAAA")
        ? answer(0, "2606:4700::1111")
        : answer(0, "alias.example.", "8.8.8.8");
    });
    expect(await dohHostResolver("doh.example")).toEqual({
      kind: "Resolved",
      addresses: ["8.8.8.8", "2606:4700::1111"],
    });
    expect(seen.sort()).toEqual([
      "https://cloudflare-dns.com/dns-query?name=doh.example&type=A",
      "https://cloudflare-dns.com/dns-query?name=doh.example&type=AAAA",
    ]);
  });

  it("fails on a DNS error status, an HTTP error, or a network error", async () => {
    vi.stubGlobal("fetch", async () => answer(2));
    expect(await dohHostResolver("a.example")).toEqual({ kind: "Failed" });
    vi.stubGlobal("fetch", async () => new Response("no", { status: 503 }));
    expect(await dohHostResolver("a.example")).toEqual({ kind: "Failed" });
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await dohHostResolver("a.example")).toEqual({ kind: "Failed" });
  });
});

describe("checkFederatedHost", () => {
  it("does not resolve IP literals or allow-listed hosts", async () => {
    const resolver = vi.fn(failing);
    expect(await checkFederatedHost("8.8.8.8", "example.com", { resolveHost: resolver })).toBe(
      "Admitted",
    );
    expect(
      await checkFederatedHost("peer.test", "example.com", {
        resolveHost: resolver,
        allowHosts: new Set(["peer.test"]),
      }),
    ).toBe("Admitted");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses statically blocked hosts without resolving them", async () => {
    const resolver = vi.fn(resolvingTo("8.8.8.8"));
    expect(await checkFederatedHost("10.0.0.1", "example.com", { resolveHost: resolver })).toBe(
      "Refused",
    );
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe("federated fetches", () => {
  it("do not fetch a host that resolves to a private address", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const options = { fetchSigner: unsignedFetch, resolveHost: resolvingTo("192.168.1.10") };

    const activity = await fetchActivityJson(identity(), "https://rebind.example/actor", options);
    const webfinger = await fetchWebfinger(identity(), "bob@rebind.example", options);

    expect(activity._unsafeUnwrapErr()).toEqual({ kind: "InvalidSignature" });
    expect(webfinger._unsafeUnwrapErr()).toEqual({ kind: "InvalidSignature" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("report a failed lookup as unavailable", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const options = { fetchSigner: unsignedFetch, resolveHost: failing };

    expect(
      (await fetchActivityJson(identity(), "https://a.example/x", options))._unsafeUnwrapErr(),
    ).toEqual({ kind: "VerificationUnavailable" });
    expect((await fetchWebfinger(identity(), "bob@a.example", options))._unsafeUnwrapErr()).toEqual(
      {
        kind: "VerificationUnavailable",
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("check every same-origin redirect hop", async () => {
    const resolver = vi.fn(resolvingTo("8.8.8.8"));
    const hops: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      hops.push(input.href);
      return hops.length === 1
        ? new Response(null, { status: 302, headers: { location: "/final" } })
        : new Response("{}");
    });
    const result = await fetchActivityJson(identity(), "https://ok.example/start", {
      fetchSigner: unsignedFetch,
      resolveHost: resolver,
    });
    expect(result.isOk()).toBe(true);
    expect(hops).toEqual(["https://ok.example/start", "https://ok.example/final"]);
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
