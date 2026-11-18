import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { prepareInboxDelivery } from "./delivery";
import { insertOutboundActivity } from "./outbox-store";
import { clearDnsVerdictCache, setDefaultHostResolver } from "./remote-dns";
import { envWith } from "../test/env-fixture";
import { withHostAddresses } from "../test/host-resolver-fixture";

const queuedActivity = async (): Promise<string> => {
  const inserted = await insertOutboundActivity(env.DB, {
    signer: { kind: "InstanceActor" },
    kind: "Update",
    payload: { type: "Update", id: `https://tstodon.example/activities/${crypto.randomUUID()}` },
    audience: "Inboxes",
  });
  if (inserted.isErr()) {
    throw new Error("outbound activity not stored");
  }
  return inserted.value.id;
};

const spyFetch = (status = 202, headers: Record<string, string> = {}) =>
  vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(null, { status, headers }));

describe("inbox delivery host guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearDnsVerdictCache();
  });

  it.each([
    "https://10.0.0.5/inbox",
    "https://127.0.0.1/inbox",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/inbox",
    "https://metadata.internal/inbox",
    "https://localhost/inbox",
  ])("never posts to the private address %s", async (inboxUrl) => {
    const post = await prepareInboxDelivery(env, await queuedActivity());
    const fetchSpy = spyFetch();
    const attempt = await post(inboxUrl);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(attempt.remote).toBe(false);
    expect(attempt.outcome.kind).toBe("PermanentFailure");
  });

  it.each(["ftp://remote.example/inbox", "file:///etc/passwd", "data:text/plain,inbox"])(
    "never posts to a non-HTTP inbox %s",
    async (inboxUrl) => {
      const post = await prepareInboxDelivery(env, await queuedActivity());
      const fetchSpy = spyFetch();
      const attempt = await post(inboxUrl);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(attempt.outcome.kind).toBe("PermanentFailure");
    },
  );

  it("never posts to a public name that resolves to a private address", async () => {
    await withHostAddresses({ "rebind.example": ["192.168.1.10"] }, async () => {
      const post = await prepareInboxDelivery(env, await queuedActivity());
      const fetchSpy = spyFetch();
      const attempt = await post("https://rebind.example/inbox");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(attempt.outcome.kind).toBe("PermanentFailure");
    });
  });

  it("retries, without posting, when the inbox host's DNS cannot be checked", async () => {
    setDefaultHostResolver(async () => ({ kind: "Failed" }));
    try {
      const post = await prepareInboxDelivery(env, await queuedActivity());
      const fetchSpy = spyFetch();
      const attempt = await post("https://dns-down.example/inbox");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(attempt).toEqual({
        outcome: { kind: "TransientFailure", cause: { kind: "Local" } },
        remote: false,
      });
    } finally {
      setDefaultHostResolver(async () => ({ kind: "Resolved", addresses: ["93.184.216.34"] }));
    }
  });

  it("counts a name DNS says does not exist against the remote, without posting", async () => {
    setDefaultHostResolver(async () => ({ kind: "DnsError", status: 3 }));
    try {
      const post = await prepareInboxDelivery(env, await queuedActivity());
      const fetchSpy = spyFetch();
      const attempt = await post("https://nxdomain.example/inbox");
      expect(fetchSpy).not.toHaveBeenCalled();
      // As a failed connection: retried, and held against the domain's health.
      expect(attempt).toEqual({
        outcome: { kind: "TransientFailure", cause: { kind: "Network" } },
        remote: true,
      });
    } finally {
      setDefaultHostResolver(async () => ({ kind: "Resolved", addresses: ["93.184.216.34"] }));
    }
  });

  it("does not follow a redirect, and retries the delivery later", async () => {
    const post = await prepareInboxDelivery(env, await queuedActivity());
    const fetchSpy = spyFetch(302, { location: "http://169.254.169.254/" });
    const attempt = await post("https://remote.example/inbox");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(attempt).toEqual({
      outcome: { kind: "TransientFailure", cause: { kind: "HttpStatus", httpStatus: 302 } },
      remote: true,
    });
  });

  it("posts to a loopback host FEDERATION_ALLOW_HOSTS names", async () => {
    const allowed = envWith({ FEDERATION_ALLOW_HOSTS: "127.0.0.1,localhost" });
    const post = await prepareInboxDelivery(allowed, await queuedActivity());
    const fetchSpy = spyFetch();
    const attempt = await post("http://127.0.0.1:8788/users/alice/inbox");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(attempt.outcome.kind).toBe("Success");
  });
});
