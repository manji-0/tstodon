import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";

const call = (path: string, init?: RequestInit) => SELF.fetch(`https://example.com${path}`, init);

const read = async <T>(schema: z.ZodType<T>, response: Response): Promise<T> => {
  const body: unknown = await response.json();
  const parsed = schemaResult(schema)(body);
  if (parsed.isErr()) {
    throw new Error(`response schema rejected: ${JSON.stringify(body)}`);
  }
  return parsed.value;
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/** Answers `acct:` lookups by WebFinger host, `subject` and `self` link as each host claims. */
type WebfingerAnswers = Readonly<Record<string, Readonly<{ subject: string; self: string }>>>;

/**
 * Serves `remote`'s actor document from its URI and the WebFinger answers by
 * host, as the remote servers would; the actor is not cached beforehand.
 */
const serveRemote = (remote: Remote, username: string, answers: WebfingerAnswers): void => {
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.href === remote.actorUri) {
      return jsonResponse({
        id: remote.actorUri,
        type: "Person",
        preferredUsername: username,
        inbox: `${remote.actorUri}/inbox`,
        publicKey: {
          id: `${remote.actorUri}#main-key`,
          owner: remote.actorUri,
          publicKeyPem: remote.publicKeyPem,
        },
      });
    }
    const answer = answers[url.host];
    if (url.pathname === "/.well-known/webfinger" && answer) {
      return jsonResponse({
        subject: answer.subject,
        links: [{ rel: "self", type: "application/activity+json", href: answer.self }],
      });
    }
    if (url.pathname === "/.well-known/webfinger") {
      return new Response(null, { status: 404 });
    }
    return original(input, init);
  });
};

const post = async (email: string, status: string) =>
  read(
    z.object({ uri: z.string() }),
    await call("/api/v1/statuses", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(email)) },
      body: JSON.stringify({ status }),
    }),
  );

const favouritedBy = async (email: string): Promise<string[]> =>
  (
    await read(
      z.array(z.object({ type: z.string(), account: z.object({ acct: z.string() }) })),
      await call("/api/v1/notifications", { headers: await authHeaders(email) }),
    )
  )
    .filter((entry) => entry.type === "favourite")
    .map((entry) => entry.account.acct);

const acctOf = async (actorUri: string): Promise<string> =>
  (
    await read(
      z.object({ acct: z.string() }),
      await call(`/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`),
    )
  ).acct;

const like = async (remote: Remote, slug: string, email: string): Promise<number> =>
  remote.send({
    id: `${new URL(remote.actorUri).origin}/activities/${slug}`,
    type: "Like",
    object: (await post(email, slug)).uri,
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a remote actor whose WebFinger domain differs from its URI host", () => {
  it("stores the domain WebFinger confirms, and a block on that domain screens it", async () => {
    const remote = await remoteActor("alice", "social.wf-split.example", { cache: false });
    serveRemote(remote, "alice", {
      "social.wf-split.example": { subject: "acct:alice@wf-split.example", self: remote.actorUri },
      "wf-split.example": { subject: "acct:alice@wf-split.example", self: remote.actorUri },
    });
    const blocker = "wf-split-blocker@example.com";
    const viewer = "wf-split-viewer@example.com";
    const blocked = await call("/api/v1/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(blocker)) },
      body: JSON.stringify({ domain: "wf-split.example" }),
    });
    expect(blocked.status).toBe(200);

    expect(await like(remote, "wf-split-viewer", viewer)).toBe(202);
    expect(await like(remote, "wf-split-blocker", blocker)).toBe(202);

    expect({
      acct: await acctOf(remote.actorUri),
      viewer: await favouritedBy(viewer),
      blocker: await favouritedBy(blocker),
    }).toEqual({ acct: "alice@wf-split.example", viewer: ["alice@wf-split.example"], blocker: [] });
  });

  it("keeps the URI host when the claimed domain's WebFinger names another actor", async () => {
    const remote = await remoteActor("mallory", "social.wf-claimer.example", { cache: false });
    serveRemote(remote, "mallory", {
      "social.wf-claimer.example": {
        subject: "acct:mallory@wf-victim.example",
        self: remote.actorUri,
      },
      "wf-victim.example": {
        subject: "acct:mallory@wf-victim.example",
        self: "https://wf-victim.example/users/mallory",
      },
    });
    const viewer = "wf-claimer-viewer@example.com";
    expect(await like(remote, "wf-claimer", viewer)).toBe(202);

    expect(await acctOf(remote.actorUri)).toBe("mallory@social.wf-claimer.example");
  });

  it("refuses its deliveries once its URI host is suspended, whatever its account domain", async () => {
    const remote = await remoteActor("bob", "social.wf-suspended.example", {
      accountDomain: "wf-suspended.example",
    });
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('wf-suspended-host', 'social.wf-suspended.example', 'suspend')",
    ).run();

    expect(await like(remote, "wf-suspended", "wf-suspended-viewer@example.com")).toBe(403);
  });
});
