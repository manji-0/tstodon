import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";
import { refreshStaleRemoteActors } from "./remote-actor-refresh";
import { handleScheduled } from "./scheduled-handler";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

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

/**
 * Answers `acct:` lookups by WebFinger host: the `subject` and `self` link
 * each host claims, or an HTTP error status.
 */
type WebfingerAnswers = Readonly<
  Record<string, Readonly<{ subject: string; self: string }> | Readonly<{ status: number }>>
>;

/**
 * Serves `remote`'s actor document from its URI and the WebFinger answers by
 * host, as the remote servers would. Any other URL goes to the network, or
 * answers `unknownStatus` when one is given.
 */
const serveRemote = (
  remote: Remote,
  username: string,
  answers: WebfingerAnswers,
  unknownStatus?: number,
): void => {
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
    if (url.pathname === "/.well-known/webfinger" && answer && "status" in answer) {
      return new Response(null, { status: answer.status });
    }
    if (url.pathname === "/.well-known/webfinger" && answer) {
      return jsonResponse({
        subject: answer.subject,
        links: [{ rel: "self", type: "application/activity+json", href: answer.self }],
      });
    }
    if (url.pathname === "/.well-known/webfinger") {
      return new Response(null, { status: 404 });
    }
    return unknownStatus === undefined
      ? original(input, init)
      : new Response(null, { status: unknownStatus });
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

/** Older than every other cached actor, so a refresh takes it first. */
const EPOCH = "1970-01-01T00:00:00.000Z";

const suspend = async (id: string, domain: string): Promise<void> => {
  await env.DB.prepare("INSERT INTO domain_blocks (id, domain, severity) VALUES (?, ?, 'suspend')")
    .bind(id, domain)
    .run();
};

const scheduled = async (cron: string): Promise<void> => {
  const ctx = createExecutionContext();
  handleScheduled({ cron, scheduledTime: Date.now(), noRetry: () => undefined }, env, ctx);
  await waitOnExecutionContext(ctx);
};

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

describe("an actor cached before the WebFinger round trip", () => {
  it("takes the confirmed domain when the cron re-fetches it", async () => {
    const remote = await remoteActor("carol", "social.wf-stale.example", { fetchedAt: EPOCH });
    expect(await acctOf(remote.actorUri)).toBe("carol@social.wf-stale.example");
    serveRemote(remote, "carol", {
      "social.wf-stale.example": { subject: "acct:carol@wf-stale.example", self: remote.actorUri },
      "wf-stale.example": { subject: "acct:carol@wf-stale.example", self: remote.actorUri },
    });

    await refreshStaleRemoteActors(env);

    expect(await acctOf(remote.actorUri)).toBe("carol@wf-stale.example");
  });
});

describe("a re-fetch whose WebFinger confirmation cannot complete", () => {
  it.each([
    ["the account domain answers 503", "blip", { "wf-blip.example": { status: 503 } }],
    ["the account domain answers 404", "gone", { "wf-gone.example": { status: 404 } }],
    ["the URI host answers 503", "down", { "social.wf-down.example": { status: 503 } }],
  ] as const)("keeps the stored account domain when %s", async (_, slug, failures) => {
    const host = `social.wf-${slug}.example`;
    const remote = await remoteActor("dave", host, {
      accountDomain: `wf-${slug}.example`,
      fetchedAt: EPOCH,
    });
    const confirmed = { subject: `acct:dave@wf-${slug}.example`, self: remote.actorUri };
    serveRemote(remote, "dave", {
      [host]: confirmed,
      [`wf-${slug}.example`]: confirmed,
      ...failures,
    });

    await refreshStaleRemoteActors(env);

    expect(await acctOf(remote.actorUri)).toBe(`dave@wf-${slug}.example`);
  });

  it("keeps refusing an actor whose suspended account domain refuses the lookup", async () => {
    const remote = await remoteActor("sam", "social.wf-susp-acct.example", {
      accountDomain: "wf-susp-acct.example",
      fetchedAt: EPOCH,
    });
    await suspend("wf-susp-acct", "wf-susp-acct.example");
    const confirmed = { subject: "acct:sam@wf-susp-acct.example", self: remote.actorUri };
    serveRemote(remote, "sam", {
      "social.wf-susp-acct.example": confirmed,
      "wf-susp-acct.example": confirmed,
    });
    const viewer = "wf-susp-acct-viewer@example.com";
    expect(await like(remote, "wf-susp-acct-1", viewer)).toBe(403);

    await refreshStaleRemoteActors(env);

    expect(await like(remote, "wf-susp-acct-2", viewer)).toBe(403);
  });

  it("refuses a first-seen actor whose claimed account domain is suspended", async () => {
    const remote = await remoteActor("tess", "social.wf-susp-new.example", { cache: false });
    await suspend("wf-susp-new", "wf-susp-new.example");
    const confirmed = { subject: "acct:tess@wf-susp-new.example", self: remote.actorUri };
    serveRemote(remote, "tess", {
      "social.wf-susp-new.example": confirmed,
      "wf-susp-new.example": confirmed,
    });

    expect(await like(remote, "wf-susp-new", "wf-susp-new-viewer@example.com")).toBe(403);
  });
});

describe("a WebFinger subject with a trailing dot", () => {
  it("names the same domain without it", async () => {
    const remote = await remoteActor("dot", "wf-dot.example", { cache: false });
    const dotted = { subject: "acct:dot@wf-dot.example.", self: remote.actorUri };
    serveRemote(remote, "dot", { "wf-dot.example": dotted, "wf-dot.example.": dotted });

    expect(await like(remote, "wf-dot", "wf-dot-viewer@example.com")).toBe(202);

    expect(await acctOf(remote.actorUri)).toBe("dot@wf-dot.example");
  });
});

describe("the stale actor refresh", () => {
  it("moves past actors whose servers do not answer", async () => {
    for (const index of Array.from({ length: 10 }, (_, i) => i)) {
      await remoteActor(`dead${index}`, `wf-dead${index}.example`, { fetchedAt: EPOCH });
    }
    const remote = await remoteActor("erin", "social.wf-after-dead.example", {
      fetchedAt: "1970-01-01T00:00:01.000Z",
    });
    const confirmed = { subject: "acct:erin@wf-after-dead.example", self: remote.actorUri };
    serveRemote(
      remote,
      "erin",
      { "social.wf-after-dead.example": confirmed, "wf-after-dead.example": confirmed },
      503,
    );

    await refreshStaleRemoteActors(env);
    await refreshStaleRemoteActors(env);

    expect(await acctOf(remote.actorUri)).toBe("erin@wf-after-dead.example");
  });

  it("runs on the hourly cron only", async () => {
    const remote = await remoteActor("fay", "social.wf-hourly.example", { fetchedAt: EPOCH });
    const confirmed = { subject: "acct:fay@wf-hourly.example", self: remote.actorUri };
    serveRemote(
      remote,
      "fay",
      { "social.wf-hourly.example": confirmed, "wf-hourly.example": confirmed },
      503,
    );

    await scheduled("17 */6 * * *");
    expect(await acctOf(remote.actorUri)).toBe("fay@social.wf-hourly.example");

    await scheduled("17 * * * *");
    expect(await acctOf(remote.actorUri)).toBe("fay@wf-hourly.example");
  });
});

const adminBlock = async (body: Record<string, unknown>): Promise<void> => {
  const response = await call("/api/v1/admin/domain_blocks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(await authHeaders("wf-rules-admin@example.com", { admin: true })),
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};

const RemoteStatusSchema = z.object({
  uri: z.string(),
  media_attachments: z.array(z.unknown()),
});

const publicTimeline = async (path: string) =>
  read(z.array(RemoteStatusSchema), await call(`${path}${path.includes("?") ? "&" : "?"}limit=40`));

/** A cached actor served from `social.<slug>.example` whose account domain is `<slug>.example`. */
const splitActor = (username: string, slug: string) =>
  remoteActor(username, `social.${slug}.example`, { accountDomain: `${slug}.example` });

const note = (remote: Remote, slug: string, extra: Record<string, unknown> = {}) => ({
  id: `${remote.actorUri}/statuses/${slug}`,
  type: "Note",
  attributedTo: remote.actorUri,
  content: `<p>${slug} #wfrules</p>`,
  published: new Date().toISOString(),
  to: [PUBLIC],
  tag: [{ type: "Hashtag", name: "#wfrules", href: "https://example.com/tags/wfrules" }],
  ...extra,
});

const create = async (remote: Remote, object: Record<string, unknown>): Promise<number> =>
  remote.send({ id: `${String(object.id)}/activity`, type: "Create", object });

describe("an instance rule on the URI host of an actor with another account domain", () => {
  it("silence hides its posts from the public and tag timelines", async () => {
    const remote = await splitActor("mia", "wf-silenced");
    await adminBlock({ domain: "social.wf-silenced.example", severity: "silence" });
    const posted = note(remote, "silenced");
    expect(await create(remote, posted)).toBe(202);

    const uris = [
      ...(await publicTimeline("/api/v1/timelines/public?remote=true")),
      ...(await publicTimeline("/api/v1/timelines/tag/wfrules")),
    ].map((status) => status.uri);
    expect(uris).not.toContain(posted.id);
  });

  it("reject_media drops the media it stored and the media it sends", async () => {
    const remote = await splitActor("max", "wf-media");
    const attached = (slug: string) =>
      note(remote, slug, {
        attachment: [
          { type: "Document", mediaType: "image/png", url: `https://social.wf-media.example/${slug}.png` },
        ],
      });
    expect(await create(remote, attached("media-before"))).toBe(202);
    await adminBlock({ domain: "social.wf-media.example", severity: "noop", reject_media: true });
    expect(await create(remote, attached("media-after"))).toBe(202);

    const statuses = (await publicTimeline("/api/v1/timelines/public?remote=true")).filter(
      (status) => status.uri.startsWith(remote.actorUri),
    );
    expect(statuses.map((status) => status.media_attachments)).toEqual([[], []]);
  });

  it("reject_reports ignores the reports it files", async () => {
    const remote = await splitActor("rex", "wf-reports");
    await adminBlock({ domain: "social.wf-reports.example", severity: "noop", reject_reports: true });
    const target = await signedInAccount("wf-reported@example.com");
    expect(
      await remote.send({
        id: `${remote.actorUri}/flags/1`,
        type: "Flag",
        content: "noise",
        object: [`https://example.com/users/${target.username}`],
      }),
    ).toBe(202);

    const reports = await read(
      z.array(z.unknown()),
      await call(`/api/v1/admin/reports?account_id=${RemoteAccountId.encode(remote.actorUri)}`, {
        headers: await authHeaders("wf-rules-admin@example.com", { admin: true }),
      }),
    );
    expect(reports).toEqual([]);
  });

  it("suspension severs its follows and hides its account", async () => {
    const remote = await splitActor("sid", "wf-severed");
    const email = "wf-severed-followed@example.com";
    const account = await signedInAccount(email);
    expect(
      await remote.send({
        id: `${remote.actorUri}/follows/1`,
        type: "Follow",
        object: `https://example.com/users/${account.username}`,
      }),
    ).toBe(202);

    await adminBlock({ domain: "social.wf-severed.example", severity: "suspend" });

    const events = (
      await read(
        z.array(z.object({ event: z.object({ type: z.string(), followers_count: z.number() }) })),
        await call("/api/v1/notifications?types[]=severed_relationships", {
          headers: await authHeaders(email),
        }),
      )
    ).map((notification) => notification.event);
    expect(events).toEqual([{ type: "domain_block", followers_count: 1 }]);
    expect((await call(`/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}`)).status).toBe(
      404,
    );
  });

  it("a user's block on the URI host does not screen it", async () => {
    const remote = await splitActor("uma", "wf-user-host");
    const blocker = "wf-user-host-blocker@example.com";
    const blocked = await call("/api/v1/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(blocker)) },
      body: JSON.stringify({ domain: "social.wf-user-host.example" }),
    });
    expect(blocked.status).toBe(200);

    expect(await like(remote, "wf-user-host", blocker)).toBe(202);

    expect(await favouritedBy(blocker)).toEqual(["uma@wf-user-host.example"]);
  });
});
