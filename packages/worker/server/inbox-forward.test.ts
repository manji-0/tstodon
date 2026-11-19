import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { forgetInboxRefusalWindows } from "./inbox-refusal";
import { postInbox } from "./routes/activitypub";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
  forgetInboxRefusalWindows();
});

const note = (author: Remote, slug: string, content: string): Record<string, unknown> => ({
  id: `${author.actorUri}/statuses/${slug}`,
  type: "Note",
  attributedTo: author.actorUri,
  content,
  published: new Date().toISOString(),
  to: [PUBLIC],
  cc: [`${author.actorUri}/followers`],
});

const create = (author: Remote, slug: string, content = `<p>${slug}</p>`) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `${author.actorUri}/statuses/${slug}/activity`,
  type: "Create",
  actor: author.actorUri,
  to: [PUBLIC],
  object: note(author, slug, content),
});

const storedContent = async (objectUri: string): Promise<string | undefined> => {
  const row = await env.DB.prepare("SELECT content_html FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .first<{ content_html: string }>();
  return row?.content_html;
};

/** The `InboxRefused` lines logged while `run` posts. */
const refusalsDuring = async (run: () => Promise<Response>) => {
  const warn = vi.spyOn(console, "warn");
  const response = await run();
  const refusals = warn.mock.calls
    .map(([line]) => (typeof line === "string" ? JSON.parse(line) : undefined))
    .filter((event) => event?.kind === "InboxRefused");
  warn.mockRestore();
  return { status: response.status, refusals };
};

// The inbox runs in this isolate, so that `forgetInboxRefusalWindows` lets
// every refusal be logged.
const app = new Hono<{ Bindings: Env }>();
app.post("/inbox", postInbox);

const post = async (request: Request | Promise<Request>): Promise<Response> =>
  app.request(await request, undefined, env, createExecutionContext());

describe("forwarded activities", () => {
  it("applies a forwarded Create, Update and Delete that their actor signed", async () => {
    const alice = await remoteActor("fwd-alice", "fwd-origin.example");
    const relay = await remoteActor("fwd-relay", "fwd-forwarder.example");
    const created = create(alice, "1", "<p>first</p>");
    const objectUri = `${alice.actorUri}/statuses/1`;

    expect((await post(relay.forward(await alice.ldSigned(created)))).status).toBe(202);
    expect(await storedContent(objectUri)).toContain("first");

    const update = {
      id: `${objectUri}#updates/1`,
      type: "Update",
      to: [PUBLIC],
      object: {
        ...note(alice, "1", "<p>edited</p>"),
        updated: new Date(Date.now() + 1000).toISOString(),
      },
    };
    expect((await post(relay.forward(await alice.ldSigned(update)))).status).toBe(202);
    expect(await storedContent(objectUri)).toContain("edited");

    const remove = {
      id: `${objectUri}#delete`,
      type: "Delete",
      to: [PUBLIC],
      object: { id: objectUri, type: "Tombstone" },
    };
    expect((await post(relay.forward(await alice.ldSigned(remove)))).status).toBe(202);
    expect(await storedContent(objectUri)).toBeUndefined();
  });

  it("applies a forward the actor's own server sends for another of its actors", async () => {
    const alice = await remoteActor("fwd-same-alice", "fwd-same.example");
    const carol = await remoteActor("fwd-same-carol", "fwd-same.example");
    expect((await post(carol.forward(await alice.ldSigned(create(alice, "same"))))).status).toBe(
      202,
    );
    expect(await storedContent(`${alice.actorUri}/statuses/same`)).toContain("same");
  });

  it("drops a forward its actor did not sign, as Mastodon, answering 202", async () => {
    const alice = await remoteActor("fwd-forged-alice", "fwd-forged.example");
    const mallory = await remoteActor("fwd-forged-mallory", "fwd-mallory.example");
    const { status, refusals } = await refusalsDuring(() =>
      post(mallory.forward(create(alice, "forged", "<p>forged</p>"))),
    );
    expect(status).toBe(202);
    expect(refusals).toMatchObject([
      { reason: "UnverifiedForward", status: 202, detail: "Unsigned", signer: mallory.actorUri },
    ]);
    expect(await storedContent(`${alice.actorUri}/statuses/forged`)).toBeUndefined();
  });

  it("drops a forward signed with another actor's key in the actor's name", async () => {
    const alice = await remoteActor("fwd-wrongkey-alice", "fwd-wrongkey.example");
    const mallory = await remoteActor("fwd-wrongkey-mallory", "fwd-mallory.example");
    // Mallory's own signature on Alice's activity: the key is not Alice's.
    const byMallory = await mallory.ldSigned(create(alice, "wrongkey"));
    const { refusals } = await refusalsDuring(() => post(mallory.forward(byMallory)));
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "KeyRejected" }]);
    // Mallory's signature claiming to be made with Alice's key.
    const claimed = {
      ...byMallory,
      signature: {
        ...(typeof byMallory["signature"] === "object" ? byMallory["signature"] : {}),
        creator: `${alice.actorUri}#main-key`,
      },
    };
    const second = await refusalsDuring(() => post(mallory.forward(claimed)));
    expect(second.refusals).toMatchObject([
      { reason: "UnverifiedForward", detail: "SignatureMismatch" },
    ]);
    expect(await storedContent(`${alice.actorUri}/statuses/wrongkey`)).toBeUndefined();
  });

  it("drops a forward whose body changed after its actor signed it", async () => {
    const alice = await remoteActor("fwd-tamper-alice", "fwd-tamper.example");
    const relay = await remoteActor("fwd-tamper-relay", "fwd-forwarder.example");
    const signed = await alice.ldSigned(create(alice, "tamper", "<p>original</p>"));
    const tampered = { ...signed, object: note(alice, "tamper", "<p>tampered</p>") };
    const { status, refusals } = await refusalsDuring(() => post(relay.forward(tampered)));
    expect(status).toBe(202);
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "SignatureMismatch" }]);
    expect(await storedContent(`${alice.actorUri}/statuses/tamper`)).toBeUndefined();
  });

  it("drops a forward whose signature expired, and refuses a replayed request", async () => {
    const alice = await remoteActor("fwd-old-alice", "fwd-old.example");
    const relay = await remoteActor("fwd-old-relay", "fwd-forwarder.example");
    const stale = await alice.ldSigned(create(alice, "old"), new Date(Date.now() - 3 * DAY_MS));
    const expired = await refusalsDuring(() => post(relay.forward(stale)));
    expect(expired.refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "Expired" }]);
    expect(await storedContent(`${alice.actorUri}/statuses/old`)).toBeUndefined();

    // A captured forward: replayed later, its request date is refused.
    const fresh = await alice.ldSigned(create(alice, "replay"));
    const captured = await relay.forward(fresh, new Date(Date.now() - 2 * 60 * 60 * 1000));
    const replayed = await refusalsDuring(() => post(captured));
    expect(replayed.status).toBe(401);
    expect(replayed.refusals).toMatchObject([{ reason: "SignatureExpired" }]);
    // Sent again with a fresh request, it is applied once: the second copy is a duplicate.
    expect((await post(relay.forward(fresh))).status).toBe(202);
    expect((await post(relay.forward(fresh))).status).toBe(202);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM remote_statuses WHERE object_uri = ?",
    )
      .bind(`${alice.actorUri}/statuses/replay`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("does not store a note on another host than the actor that signed its Create", async () => {
    const alice = await remoteActor("fwd-host-alice", "fwd-host.example");
    const relay = await remoteActor("fwd-host-relay", "fwd-forwarder.example");
    const foreign = {
      ...create(alice, "foreign"),
      object: {
        ...note(alice, "foreign", "<p>elsewhere</p>"),
        id: "https://elsewhere.example/notes/1",
      },
    };
    expect((await post(relay.forward(await alice.ldSigned(foreign)))).status).toBe(202);
    expect(await storedContent("https://elsewhere.example/notes/1")).toBeUndefined();
    // Nor when the actor delivers it itself (Mastodon's `non_matching_uri_hosts?`).
    expect(await alice.send({ ...foreign, id: `${alice.actorUri}/statuses/foreign/again` })).toBe(
      202,
    );
    expect(await storedContent("https://elsewhere.example/notes/1")).toBeUndefined();
  });

  it("drops a forward signed with a key on a suspended domain without fetching it", async () => {
    const relay = await remoteActor("fwd-blocked-relay", "fwd-forwarder.example");
    const eve = await remoteActor("fwd-blocked-eve", "fwd-blocked.example", { cache: false });
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('fwd-blocked', ?, 'suspend')",
    )
      .bind("fwd-blocked.example")
      .run();
    const fetched = vi.spyOn(globalThis, "fetch");
    const response = await post(relay.forward(await eve.ldSigned(create(eve, "blocked"))));
    expect(response.status).toBe(403);
    expect(fetched).not.toHaveBeenCalled();
  });
});

/** An actor's cached row, with the key it publishes as `#main-key`. */
const actorRow = async (actorUri: string) =>
  env.DB.prepare(
    `SELECT a.display_name, k.public_key_pem FROM remote_actors AS a
     LEFT JOIN remote_actor_keys AS k ON k.key_id = a.actor_uri || '#main-key'
     WHERE a.actor_uri = ?`,
  )
    .bind(actorUri)
    .first<{ display_name: string; public_key_pem: string | null }>();

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return { ...value };
};

/** An actor document for `remote`, as an activity embeds it (`serve` adds the context). */
const actorDocument = (remote: Remote, overrides: Record<string, unknown> = {}) => ({
  id: remote.actorUri,
  type: "Person",
  preferredUsername: new URL(remote.actorUri).pathname.split("/").at(-1),
  name: "Fetched",
  inbox: `${remote.actorUri}/inbox`,
  publicKey: {
    id: `${remote.actorUri}#main-key`,
    owner: remote.actorUri,
    publicKeyPem: remote.publicKeyPem,
  },
  ...overrides,
});

const ACTOR_CONTEXT = ["https://www.w3.org/ns/activitystreams", "https://w3id.org/security/v1"];

/** `fetch` answering `documents` by URL (the fragment dropped), 404 for anything else. */
const serve = (documents: Readonly<Record<string, unknown>>, status = 200) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    url.hash = "";
    const document = documents[url.href];
    return document === undefined
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ "@context": ACTOR_CONTEXT, ...record(document) }), {
          status,
          headers: { "content-type": "application/activity+json" },
        });
  });

describe("forwards whose JSON says something else than their signature", () => {
  it("drops a note whose content a nested context rewrites, the signature intact", async () => {
    const alice = await remoteActor("fwd-ctx-alice", "fwd-ctx.example");
    const relay = await remoteActor("fwd-ctx-relay", "fwd-forwarder.example");
    const signed = await alice.ldSigned(create(alice, "ctx", "<p>signed</p>"));
    const object = record(signed["object"]);
    const forged = {
      ...signed,
      object: {
        ...object,
        "@context": { content: null },
        content: "<p>forged</p>",
        "as:content": object["content"],
      },
    };
    const { status, refusals } = await refusalsDuring(() => post(relay.forward(forged)));
    expect(status).toBe(202);
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "AmbiguousJsonLd" }]);
    expect(await storedContent(`${alice.actorUri}/statuses/ctx`)).toBeUndefined();
  });

  it("drops a Delete that `@id` retargets at another status or at the actor", async () => {
    const alice = await remoteActor("fwd-retarget-alice", "fwd-retarget.example");
    const relay = await remoteActor("fwd-retarget-relay", "fwd-forwarder.example");
    for (const slug of ["kept", "deleted"]) {
      expect(await alice.send(create(alice, slug))).toBe(202);
    }
    const deleted = `${alice.actorUri}/statuses/deleted`;
    const signed = await alice.ldSigned({
      id: `${deleted}#delete`,
      type: "Delete",
      to: [PUBLIC],
      object: { id: deleted, type: "Tombstone" },
    });
    for (const id of [`${alice.actorUri}/statuses/kept`, alice.actorUri]) {
      const forged = {
        ...signed,
        id: `${String(signed["id"])}-${id.length}`,
        object: { "@context": { id: null }, "@id": deleted, id, type: "Tombstone" },
      };
      const { refusals } = await refusalsDuring(() => post(relay.forward(forged)));
      expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "AmbiguousJsonLd" }]);
    }
    expect(await storedContent(`${alice.actorUri}/statuses/kept`)).toBeDefined();
    expect(await actorRow(alice.actorUri)).not.toBeNull();
  });

  it("drops an actor Update whose key a nested context swaps", async () => {
    const alice = await remoteActor("fwd-key-alice", "fwd-key.example");
    const relay = await remoteActor("fwd-key-relay", "fwd-forwarder.example");
    const evil = await remoteActor("fwd-key-evil", "fwd-key-evil.example", { cache: false });
    const document = actorDocument(alice);
    const signed = await alice.ldSigned({
      id: `${alice.actorUri}#updates/1`,
      "@context": ACTOR_CONTEXT,
      type: "Update",
      to: [PUBLIC],
      object: document,
    });
    const forged = {
      ...signed,
      object: {
        ...document,
        publicKey: {
          ...document.publicKey,
          "@context": { publicKeyPem: null },
          publicKeyPem: evil.publicKeyPem,
          "https://w3id.org/security#publicKeyPem": alice.publicKeyPem,
        },
      },
    };
    const { refusals } = await refusalsDuring(() => post(relay.forward(forged)));
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "AmbiguousJsonLd" }]);
    expect((await actorRow(alice.actorUri))?.public_key_pem).toBe(alice.publicKeyPem);
  });

  it("drops a signature whose expiry is written as `sec:expiration`", async () => {
    const alice = await remoteActor("fwd-exp-alice", "fwd-exp.example");
    const relay = await remoteActor("fwd-exp-relay", "fwd-forwarder.example");
    const stale = await alice.ldSigned(create(alice, "exp"), new Date(Date.now() - 3 * DAY_MS));
    const { expires, ...signature } = record(stale["signature"]);
    const forged = {
      ...stale,
      signature: { ...signature, "sec:expiration": { "@value": expires, "@type": "xsd:dateTime" } },
    };
    const { refusals } = await refusalsDuring(() => post(relay.forward(forged)));
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "AmbiguousJsonLd" }]);
    expect(await storedContent(`${alice.actorUri}/statuses/exp`)).toBeUndefined();
  });
});

describe("forwarded actor activities", () => {
  it("takes a forwarded actor Update from the actor's own document, not the one it carries", async () => {
    const alice = await remoteActor("fwd-upd-alice", "fwd-upd.example");
    const relay = await remoteActor("fwd-upd-relay", "fwd-forwarder.example");
    serve({ [alice.actorUri]: actorDocument(alice, { name: "Fetched" }) });
    const signed = await alice.ldSigned({
      id: `${alice.actorUri}#updates/2`,
      "@context": ACTOR_CONTEXT,
      type: "Update",
      to: [PUBLIC],
      object: actorDocument(alice, { name: "Embedded" }),
    });
    expect((await post(relay.forward(signed))).status).toBe(202);
    expect((await actorRow(alice.actorUri))?.display_name).toBe("Fetched");
  });

  it("purges an account on a forwarded Delete only when its server no longer serves it", async () => {
    const alice = await remoteActor("fwd-gone-alice", "fwd-gone.example");
    const relay = await remoteActor("fwd-gone-relay", "fwd-forwarder.example");
    const remove = (n: number) => ({
      id: `${alice.actorUri}#delete-${n}`,
      type: "Delete",
      to: [PUBLIC],
      object: alice.actorUri,
    });
    const alive = serve({ [alice.actorUri]: actorDocument(alice) });
    expect((await post(relay.forward(await alice.ldSigned(remove(1))))).status).toBe(202);
    expect(await actorRow(alice.actorUri)).not.toBeNull();
    alive.mockRestore();
    // Failures that are not the origin saying the account is gone.
    const notGone = [
      () => new Response(null, { status: 403 }),
      () => new Response("not json", { status: 200 }),
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      () => new Response(null, { status: 500 }),
    ];
    for (const [n, answer] of notGone.entries()) {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => answer());
      expect((await post(relay.forward(await alice.ldSigned(remove(10 + n))))).status).toBe(202);
      expect(await actorRow(alice.actorUri)).not.toBeNull();
      spy.mockRestore();
    }
    serve({ [alice.actorUri]: {} }, 410);
    expect((await post(relay.forward(await alice.ldSigned(remove(2))))).status).toBe(202);
    expect(await actorRow(alice.actorUri)).toBeNull();
  });

  it("verifies a forward from an actor not cached yet, fetching its key", async () => {
    const alice = await remoteActor("fwd-new-alice", "fwd-new.example", { cache: false });
    const relay = await remoteActor("fwd-new-relay", "fwd-forwarder.example");
    serve({ [alice.actorUri]: actorDocument(alice) });
    expect((await post(relay.forward(await alice.ldSigned(create(alice, "new"))))).status).toBe(
      202,
    );
    expect(await storedContent(`${alice.actorUri}/statuses/new`)).toContain("new");
  });

  it("does not take an actor's key from a document served on another host", async () => {
    const alice = await remoteActor("fwd-host-key-alice", "fwd-host-key.example");
    const relay = await remoteActor("fwd-host-key-relay", "fwd-forwarder.example");
    const evil = await remoteActor("fwd-host-key-evil", "fwd-host-key-evil.example", {
      cache: false,
    });
    // evil.example serves, at its own key URL, a document that claims to be
    // Alice's actor with evil's key.
    serve({
      [evil.actorUri]: actorDocument(alice, {
        publicKey: {
          id: `${evil.actorUri}#main-key`,
          owner: alice.actorUri,
          publicKeyPem: evil.publicKeyPem,
        },
      }),
    });
    const signed = await evil.ldSigned({ ...create(alice, "evil"), actor: alice.actorUri });
    const { refusals } = await refusalsDuring(() => post(relay.forward(signed)));
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "KeyRejected" }]);
    expect((await actorRow(alice.actorUri))?.public_key_pem).toBe(alice.publicKeyPem);
    expect(await storedContent(`${alice.actorUri}/statuses/evil`)).toBeUndefined();
  });
});

describe("tombstones", () => {
  it("does not store again a status its author deleted, forwarded or delivered", async () => {
    const alice = await remoteActor("fwd-tomb-alice", "fwd-tomb.example");
    const relay = await remoteActor("fwd-tomb-relay", "fwd-forwarder.example");
    const objectUri = `${alice.actorUri}/statuses/tomb`;
    const signed = await alice.ldSigned(create(alice, "tomb"));
    expect((await post(alice.forward(signed))).status).toBe(202);
    expect(await storedContent(objectUri)).toBeDefined();
    expect(await alice.send({ id: `${objectUri}#delete`, type: "Delete", object: objectUri })).toBe(
      202,
    );
    expect(await storedContent(objectUri)).toBeUndefined();
    // A signed Create of it again, under another activity id, and a late Update.
    const again = await alice.ldSigned({ ...create(alice, "tomb"), id: `${objectUri}/activity-2` });
    expect((await post(relay.forward(again))).status).toBe(202);
    expect(
      await alice.send({
        id: `${objectUri}#updates/9`,
        type: "Update",
        object: { ...note(alice, "tomb", "<p>back</p>"), updated: new Date().toISOString() },
      }),
    ).toBe(202);
    expect(await storedContent(objectUri)).toBeUndefined();
  });
});
