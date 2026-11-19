import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { forgetInboxRefusalWindows } from "./inbox-refusal";

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

const post = (request: Request | Promise<Request>) =>
  Promise.resolve(request).then((ready) => SELF.fetch(ready));

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
