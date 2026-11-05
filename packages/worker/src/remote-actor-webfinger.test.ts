import { SELF, createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { Hostname } from "@tstodon/domain";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";
import { remoteActorFromDocument } from "./remote-actor-fetch";
import { refreshStaleRemoteActors } from "./remote-actor-refresh";
import { upsertRemoteActor } from "./remote-actor-store";
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

type Served = Readonly<{ remote: Remote; username: string; name?: string }>;

const actorDocument = ({ remote, username, name }: Served) => ({
  id: remote.actorUri,
  type: "Person",
  preferredUsername: username,
  ...(name === undefined ? {} : { name }),
  inbox: `${remote.actorUri}/inbox`,
  publicKey: {
    id: `${remote.actorUri}#main-key`,
    owner: remote.actorUri,
    publicKeyPem: remote.publicKeyPem,
  },
});

/**
 * Serves each actor's document from its URI and the WebFinger answers by
 * host, as the remote servers would. Any other URL goes to the network, or
 * answers `unknownStatus` when one is given. Calling it again replaces what
 * is served.
 */
const serveRemotes = (
  actors: ReadonlyArray<Served>,
  answers: WebfingerAnswers,
  unknownStatus?: number,
): void => {
  vi.restoreAllMocks();
  const original = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    const served = actors.find((actor) => new URL(actor.remote.actorUri).href === url.href);
    if (served) {
      return jsonResponse(actorDocument(served));
    }
    const answer = answers[url.host];
    if (url.pathname === "/.well-known/webfinger") {
      if (!answer) {
        return new Response(null, { status: 404 });
      }
      if ("status" in answer) {
        return new Response(null, { status: answer.status });
      }
      return jsonResponse({
        subject: answer.subject,
        links: [{ rel: "self", type: "application/activity+json", href: answer.self }],
      });
    }
    return unknownStatus === undefined
      ? original(input, init)
      : new Response(null, { status: unknownStatus });
  });
};

const serveRemote = (
  remote: Remote,
  username: string,
  answers: WebfingerAnswers,
  unknownStatus?: number,
): void => serveRemotes([{ remote, username }], answers, unknownStatus);

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

  it.each([404, 410])(
    "moves the actor to its URI host when the account domain answers %i",
    async (status) => {
      const host = `social.wf-gone${status}.example`;
      const remote = await remoteActor("dave", host, {
        accountDomain: `wf-gone${status}.example`,
        fetchedAt: EPOCH,
      });
      serveRemote(remote, "dave", {
        [host]: { subject: `acct:dave@wf-gone${status}.example`, self: remote.actorUri },
        [`wf-gone${status}.example`]: { status },
      });

      await refreshStaleRemoteActors(env);

      expect(await acctOf(remote.actorUri)).toBe(`dave@${host}`);
    },
  );

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
          {
            type: "Document",
            mediaType: "image/png",
            url: `https://social.wf-media.example/${slug}.png`,
          },
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
    await adminBlock({
      domain: "social.wf-reports.example",
      severity: "noop",
      reject_reports: true,
    });
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

  it("a user's block on the URI host screens it", async () => {
    const remote = await splitActor("uma", "wf-user-host");
    const blocker = "wf-user-host-blocker@example.com";
    const blocked = await call("/api/v1/domain_blocks", {
      method: "POST",
      headers: { "content-type": "application/json", ...(await authHeaders(blocker)) },
      body: JSON.stringify({ domain: "social.wf-user-host.example" }),
    });
    expect(blocked.status).toBe(200);

    expect(await like(remote, "wf-user-host", blocker)).toBe(202);

    expect(await favouritedBy(blocker)).toEqual([]);
  });
});

const signedIn = async (email: string) => ({
  "content-type": "application/json",
  ...(await authHeaders(email)),
});

const blockDomain = async (email: string, domain: string): Promise<void> => {
  const blocked = await call("/api/v1/domain_blocks", {
    method: "POST",
    headers: await signedIn(email),
    body: JSON.stringify({ domain }),
  });
  expect(blocked.status).toBe(200);
};

const lookUpHandle = async (acct: string): Promise<string> =>
  (
    await read(
      z.object({ id: z.string() }),
      await call(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`),
    )
  ).id;

describe("a handle lookup answered by a third party", () => {
  it("does not move another server's actor onto the asked domain", async () => {
    const victim = await remoteActor("bob", "wf-victim-i.example", { cache: false });
    serveRemote(victim, "bob", {
      "wf-evil-i.example": { subject: "acct:alice@wf-evil-i.example", self: victim.actorUri },
      "wf-victim-i.example": { subject: "acct:bob@wf-victim-i.example", self: victim.actorUri },
    });

    const searched = await call("/api/v2/search?q=@alice@wf-evil-i.example&resolve=true", {
      headers: await authHeaders("wf-evil-i-searcher@example.com"),
    });
    expect(searched.status).toBe(200);

    expect(await acctOf(victim.actorUri)).toBe("bob@wf-victim-i.example");
  });

  it("still confirms a split domain the URI host names", async () => {
    const remote = await remoteActor("cat", "social.wf-asked.example", { cache: false });
    const confirmed = { subject: "acct:cat@wf-asked.example", self: remote.actorUri };
    serveRemote(remote, "cat", {
      "social.wf-asked.example": confirmed,
      "wf-asked.example": confirmed,
    });

    const searched = await call("/api/v2/search?q=@cat@wf-asked.example&resolve=true", {
      headers: await authHeaders("wf-asked-searcher@example.com"),
    });
    expect(searched.status).toBe(200);

    expect(await acctOf(remote.actorUri)).toBe("cat@wf-asked.example");
  });
});

describe("an account domain that WebFinger moves to another actor", () => {
  it("names the actor WebFinger confirms last, while the old one keeps answering 503", async () => {
    const old = await remoteActor("alice", "wf-old-owner.example", { cache: false });
    const next = await remoteActor("alice", "wf-new-owner.example", { cache: false });
    const actors = [
      { remote: old, username: "alice" },
      { remote: next, username: "alice" },
    ];
    serveRemotes(actors, {
      "wf-old-owner.example": { subject: "acct:alice@wf-moved.example", self: old.actorUri },
      "wf-moved.example": { subject: "acct:alice@wf-moved.example", self: old.actorUri },
    });
    expect(await like(old, "wf-moved-old", "wf-moved-viewer@example.com")).toBe(202);
    expect(await acctOf(old.actorUri)).toBe("alice@wf-moved.example");

    serveRemotes(actors, {
      "wf-old-owner.example": { status: 503 },
      "wf-new-owner.example": { subject: "acct:alice@wf-moved.example", self: next.actorUri },
      "wf-moved.example": { subject: "acct:alice@wf-moved.example", self: next.actorUri },
    });
    expect(await like(next, "wf-moved-next", "wf-moved-viewer@example.com")).toBe(202);
    expect(
      await old.send({
        id: `${old.actorUri}#updates/1`,
        type: "Update",
        object: actorDocument({ remote: old, username: "alice" }),
      }),
    ).toBe(202);

    expect({
      lookup: await lookUpHandle("alice@wf-moved.example"),
      old: await acctOf(old.actorUri),
    }).toEqual({
      lookup: RemoteAccountId.encode(next.actorUri),
      old: "alice@wf-old-owner.example",
    });
  });
});

describe("an actor's own Update", () => {
  it("applies the document under its stored handle without asking WebFinger, as Mastodon", async () => {
    const remote = await splitActor("ida", "wf-own-update");
    serveRemote(remote, "ida", {});

    expect(
      await remote.send({
        id: `${remote.actorUri}#updates/1`,
        type: "Update",
        object: actorDocument({ remote, username: "ida", name: "Ida Renamed" }),
      }),
    ).toBe(202);

    expect(
      await read(
        z.object({ acct: z.string(), display_name: z.string() }),
        await call(`/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}`),
      ),
    ).toEqual({ acct: "ida@wf-own-update.example", display_name: "Ida Renamed" });
  });
});

describe("an actor URI whose host SQL would read differently", () => {
  const tricky = [
    "https://Ksil-k.example/users/a",
    "https://bücher.example/users/a",
    "https://xn--bcher-kva.example/users/a",
    "https://Upper.Example/users/a",
    "https://port.example:8443/users/a",
    "https://port.example:443/users/a",
    "https://dot.example./users/a",
    "https://user@userinfo.example/users/a",
    "https://ex%61mple.example/users/a",
    "https://[fd00::71]:8443/users/a",
    "https://[FD00:0::71]/users/a",
    "https://evil.example\\@victim.example/users/a",
    "https://ıdotless.example/users/a",
    "https://ﬀlig.example/users/a",
  ];

  it("is refused unless SQL reads the host and authority the actor is stored under", async () => {
    const accepted: string[] = [];
    for (const uri of tricky) {
      const actor = remoteActorFromDocument(
        {
          id: uri,
          type: "Person",
          preferredUsername: "a",
          inbox: `${uri}/inbox`,
          publicKey: { id: `${uri}#main-key`, owner: uri, publicKeyPem: "pem" },
        },
        uri,
      );
      if (actor.isErr()) {
        continue;
      }
      accepted.push(uri);
      expect((await upsertRemoteActor(env.DB, actor.value)).isOk()).toBe(true);
      const row = await env.DB.prepare(
        "SELECT uri_host, lower(uri_authority) AS authority FROM remote_actors WHERE actor_uri = ?",
      )
        .bind(uri)
        .first();
      expect({ uri, ...row }).toEqual({
        uri,
        uri_host: Hostname.ofUri(uri),
        authority: actor.value.domain,
      });
    }
    expect(accepted).not.toContain("https://Ksil-k.example/users/a");
  });

  it("keeps a Kelvin-sign host's posts off the timeline its silenced host is kept off", async () => {
    const remote = await remoteActor("m", "Ksil-k.example", { cache: false });
    await adminBlock({ domain: "ksil-k.example", severity: "silence" });
    const confirmed = { subject: "acct:m@wf-alt-k.example", self: remote.actorUri };
    serveRemote(remote, "m", { "ksil-k.example": confirmed, "wf-alt-k.example": confirmed });
    const posted = {
      ...note(remote, "kelvin"),
      id: "https://ksil-k.example/users/m/statuses/kelvin",
    };
    await create(remote, posted);

    const uris = (await publicTimeline("/api/v1/timelines/public?remote=true")).map(
      (status) => status.uri,
    );
    expect(uris).not.toContain(posted.id);
  });
});

describe("the stale actor refresh batch", () => {
  it("fetches the REFRESH_BATCH longest waiting actors", async () => {
    const hosts = Array.from({ length: 12 }, (_, index) => `wf-batch${index}.example`);
    for (const [index, host] of hosts.entries()) {
      await remoteActor("b", host, {
        fetchedAt: `1970-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      });
    }
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      fetched.push(new URL(new Request(input, init).url).host);
      return new Response(null, { status: 503 });
    });

    await refreshStaleRemoteActors(env);

    expect(fetched.filter((host) => hosts.includes(host)).toSorted()).toEqual(
      hosts.slice(0, 10).toSorted(),
    );
  });
});

describe("a user's domain block on an actor's URI host", () => {
  it("keeps screening an actor cached before the cron confirms its account domain", async () => {
    const remote = await remoteActor("pia", "social.wf-preblock.example", { fetchedAt: EPOCH });
    const blocker = "wf-preblock-blocker@example.com";
    await blockDomain(blocker, "social.wf-preblock.example");
    const confirmed = { subject: "acct:pia@wf-preblock.example", self: remote.actorUri };
    serveRemote(remote, "pia", {
      "social.wf-preblock.example": confirmed,
      "wf-preblock.example": confirmed,
    });
    await refreshStaleRemoteActors(env);
    expect(await acctOf(remote.actorUri)).toBe("pia@wf-preblock.example");
    const posted = note(remote, "preblock");
    expect(await create(remote, posted)).toBe(202);
    expect(await like(remote, "wf-preblock", blocker)).toBe(202);

    const relationship = await read(
      z.array(z.object({ domain_blocking: z.boolean() })),
      await call(`/api/v1/accounts/relationships?id[]=${RemoteAccountId.encode(remote.actorUri)}`, {
        headers: await authHeaders(blocker),
      }),
    );
    const timeline = await read(
      z.array(RemoteStatusSchema),
      await call("/api/v1/timelines/public?remote=true&limit=40", {
        headers: await authHeaders(blocker),
      }),
    );
    expect({
      favouritedBy: await favouritedBy(blocker),
      domainBlocking: relationship.map((entry) => entry.domain_blocking),
      onTimeline: timeline.some((status) => status.uri === posted.id),
    }).toEqual({ favouritedBy: [], domainBlocking: [true], onTimeline: false });
  });

  it("severs the actor's follows when the block is made", async () => {
    const remote = await splitActor("sev", "wf-user-sever");
    const email = "wf-user-sever-followed@example.com";
    const account = await signedInAccount(email);
    expect(
      await remote.send({
        id: `${remote.actorUri}/follows/1`,
        type: "Follow",
        object: `https://example.com/users/${account.username}`,
      }),
    ).toBe(202);

    await blockDomain(email, "social.wf-user-sever.example");

    const events = (
      await read(
        z.array(z.object({ event: z.object({ type: z.string(), followers_count: z.number() }) })),
        await call("/api/v1/notifications?types[]=severed_relationships", {
          headers: await authHeaders(email),
        }),
      )
    ).map((notification) => notification.event);
    expect(events).toEqual([{ type: "user_domain_block", followers_count: 1 }]);
  });

  it("refuses the actor's Follow, a follow of it and a vote on its poll", async () => {
    const remote = await splitActor("fol", "wf-user-follow");
    const email = "wf-user-follow-blocker@example.com";
    const account = await signedInAccount(email);
    await blockDomain(email, "social.wf-user-follow.example");
    expect(
      await remote.send({
        id: `${remote.actorUri}/follows/1`,
        type: "Follow",
        object: `https://example.com/users/${account.username}`,
      }),
    ).toBe(202);
    const pollId = await storedPoll(remote, "wf-user-follow");

    const followers = await read(
      z.array(z.unknown()),
      await call(`/api/v1/accounts/${account.id}/followers`, { headers: await authHeaders(email) }),
    );
    const follow = await call(
      `/api/v1/accounts/${RemoteAccountId.encode(remote.actorUri)}/follow`,
      {
        method: "POST",
        headers: await signedIn(email),
        body: "{}",
      },
    );
    expect({
      followers: followers.length,
      follow: follow.status,
      vote: (await vote(email, pollId)).status,
    }).toEqual({ followers: 0, follow: 422, vote: 422 });
  });
});

const storedPoll = async (remote: Remote, slug: string): Promise<string> => {
  const object = {
    id: `${remote.actorUri}/questions/${slug}`,
    type: "Question",
    attributedTo: remote.actorUri,
    content: "<p>Which one?</p>",
    published: new Date().toISOString(),
    endTime: "2099-01-01T00:00:00Z",
    to: [PUBLIC],
    oneOf: [
      { type: "Note", name: "cats", replies: { type: "Collection", totalItems: 0 } },
      { type: "Note", name: "dogs", replies: { type: "Collection", totalItems: 0 } },
    ],
  };
  expect(await create(remote, object)).toBe(202);
  const row = schemaResult(z.object({ id: z.string() }))(
    await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
      .bind(object.id)
      .first(),
  );
  if (row.isErr()) {
    throw new Error("remote question was not stored");
  }
  return row.value.id;
};

const vote = async (email: string, pollId: string) =>
  call(`/api/v1/polls/remote-${pollId}/votes`, {
    method: "POST",
    headers: await signedIn(email),
    body: JSON.stringify({ choices: [0] }),
  });

describe("an instance rule on either host of a poll's or a mention's actor", () => {
  it("refuses a vote once the poll author's account domain is suspended", async () => {
    const remote = await splitActor("pol", "wf-poll-acct");
    const pollId = await storedPoll(remote, "wf-poll-acct");
    await adminBlock({ domain: "wf-poll-acct.example", severity: "suspend" });

    expect((await vote("wf-poll-acct-voter@example.com", pollId)).status).toBe(422);
  });

  it("leaves out a cached mention whose URI host is suspended", async () => {
    await splitActor("ann", "wf-mention-host");
    await adminBlock({ domain: "social.wf-mention-host.example", severity: "suspend" });
    serveRemotes([], {});

    const posted = await read(
      z.object({ mentions: z.array(z.object({ acct: z.string() })) }),
      await call("/api/v1/statuses", {
        method: "POST",
        headers: await signedIn("wf-mention-host-author@example.com"),
        body: JSON.stringify({ status: "hi @ann@wf-mention-host.example" }),
      }),
    );
    expect(posted.mentions).toEqual([]);
  });
});
