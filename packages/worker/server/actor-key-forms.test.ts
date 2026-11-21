import { createExecutionContext, env } from "cloudflare:test";
import { CoveredHosts, IsoInstant, RemoteActor } from "@tstodon/domain";
import { Hono } from "hono";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ed25519Signer } from "../test/integrity-proof-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { webfingerAnswer } from "../test/webfinger-fixture";
import { unsignedFetch } from "./federated-fetch";
import { contentDigestHeader, signMessageRequest } from "./http-message-signature";
import { importRsaPublicKey, signInboxRequest, verifyInboxRequest } from "./http-signature";
import { readIntegrityProof } from "./integrity-proof";
import { verifyForwardedActivity } from "./inbox-forward";
import { forgetInboxRefusalWindows } from "./inbox-refusal";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { refreshRemoteActor } from "./remote-actor-fetch";
import { multibaseKey } from "./multibase";
import {
  findRemoteActorByUri,
  findRemoteActorKey,
  LEGACY_PUBLIC_KEY_PEM,
  upsertRemoteActor,
} from "./remote-actor-store";
import { postInbox } from "./routes/activitypub";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
const AS = "https://www.w3.org/ns/activitystreams";
const DATA_INTEGRITY = "https://w3id.org/security/data-integrity/v1";

afterEach(() => {
  vi.restoreAllMocks();
  forgetInboxRefusalWindows();
});

const app = new Hono<{ Bindings: Env }>();
app.post("/inbox", postInbox);

const post = async (request: Request | Promise<Request>): Promise<Response> =>
  app.request(await request, undefined, env, createExecutionContext());

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

/**
 * `fetch` answering `documents` by URL (the fragment dropped), and WebFinger
 * for the actors among them; 404 for anything else.
 */
const serve = (
  documents: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  unreachable: ReadonlyArray<string> = [],
) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname === "/.well-known/webfinger") {
      return webfingerAnswer(documents, url);
    }
    url.hash = "";
    if (unreachable.includes(url.href)) {
      throw new TypeError("connection refused");
    }
    const document = documents[url.href];
    return document === undefined
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ "@context": [AS, DATA_INTEGRITY], ...document }), {
          headers: { "content-type": "application/activity+json" },
        });
  });

const actorDocument = (remote: Remote, overrides: Record<string, unknown> = {}) => ({
  id: remote.actorUri,
  type: "Person",
  preferredUsername: new URL(remote.actorUri).pathname.split("/").at(-1),
  inbox: `${remote.actorUri}/inbox`,
  publicKey: {
    id: `${remote.actorUri}#main-key`,
    owner: remote.actorUri,
    publicKeyPem: remote.publicKeyPem,
  },
  ...overrides,
});

const create = (author: Remote, slug: string, content = `<p>${slug}</p>`) => ({
  "@context": [AS, DATA_INTEGRITY],
  id: `${author.actorUri}/statuses/${slug}/activity`,
  type: "Create",
  actor: author.actorUri,
  to: [PUBLIC],
  object: {
    id: `${author.actorUri}/statuses/${slug}`,
    type: "Note",
    attributedTo: author.actorUri,
    content,
    published: new Date().toISOString(),
    to: [PUBLIC],
  },
});

const storedContent = async (objectUri: string): Promise<string | undefined> => {
  const row = await env.DB.prepare("SELECT content_html FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .first<{ content_html: string }>();
  return row?.content_html;
};

/** A shared-inbox delivery of `activity` signed with `privateKeyJwk` under `keyId`. */
const signedDelivery = async (
  activity: Record<string, unknown>,
  keyId: string,
  privateKeyJwk: Awaited<ReturnType<typeof generateAccountKeys>>["privateKeyJwk"],
): Promise<Request> => {
  const body = JSON.stringify(activity);
  const headers = await signInboxRequest(
    new URL("https://example.com/inbox"),
    privateKeyJwk,
    keyId,
    body,
  );
  if (headers.isErr()) {
    throw new Error(headers.error.message);
  }
  return new Request("https://example.com/inbox", {
    method: "POST",
    headers: headers.value,
    body,
  });
};

describe("actor key forms (FED-8)", () => {
  it("verifies a delivery signed with any key of a publicKey list, as Mastodon picks it by id", async () => {
    const bob = await remoteActor("keys-list-bob", "keys-list.example", { cache: false });
    const second = await generateAccountKeys();
    serve({
      [bob.actorUri]: actorDocument(bob, {
        publicKey: [
          { id: `${bob.actorUri}#main-key`, owner: bob.actorUri, publicKeyPem: bob.publicKeyPem },
          {
            id: `${bob.actorUri}#second-key`,
            owner: bob.actorUri,
            publicKeyPem: second.publicKeyPem,
          },
        ],
      }),
    });
    const bySecond = signedDelivery(
      create(bob, "second"),
      `${bob.actorUri}#second-key`,
      second.privateKeyJwk,
    );
    expect((await post(bySecond)).status).toBe(202);
    expect(await storedContent(`${bob.actorUri}/statuses/second`)).toContain("second");
    // Both keys are kept: the first verifies from the cache too.
    expect((await post(bob.delivery(create(bob, "first")))).status).toBe(202);
    expect(
      (await findRemoteActorKey(env.DB, `${bob.actorUri}#second-key`))._unsafeUnwrap()?.actor
        .actorUri,
    ).toBe(bob.actorUri);
  });

  it("refuses an HTTP signature made under an Ed25519 Multikey's id, as Mastodon's draft-cavage check does", async () => {
    const carol = await remoteActor("keys-ed-carol", "keys-ed.example", { cache: false });
    const ed = await ed25519Signer();
    const rsa = await generateAccountKeys();
    serve({
      [carol.actorUri]: actorDocument(carol, {
        assertionMethod: [
          {
            id: `${carol.actorUri}#ed25519-key`,
            type: "Multikey",
            controller: carol.actorUri,
            publicKeyMultibase: ed.publicKeyMultibase,
          },
        ],
      }),
    });
    const { status, refusals } = await refusalsDuring(() =>
      post(signedDelivery(create(carol, "ed"), `${carol.actorUri}#ed25519-key`, rsa.privateKeyJwk)),
    );
    expect(status).toBe(401);
    expect(refusals).toMatchObject([{ reason: "SignatureMismatch" }]);
    const stored = (
      await findRemoteActorKey(env.DB, `${carol.actorUri}#ed25519-key`)
    )._unsafeUnwrap();
    expect(stored).toBeUndefined();
  });

  it("verifies an RFC 9421 message signature made under an Ed25519 Multikey's id, as Mastodon's linzer does", async () => {
    const erin = await remoteActor("keys-ed-erin", "keys-ed9421.example", { cache: false });
    const ed = await ed25519Signer();
    const keyId = `${erin.actorUri}#ed25519-key`;
    serve({
      [erin.actorUri]: actorDocument(erin, {
        assertionMethod: [
          {
            id: keyId,
            type: "Multikey",
            controller: erin.actorUri,
            publicKeyMultibase: ed.publicKeyMultibase,
          },
        ],
      }),
    });
    const body = JSON.stringify(create(erin, "ed9421"));
    const headers = new Headers({
      "Content-Type": "application/activity+json",
      "Content-Digest": await contentDigestHeader(body),
    });
    const url = "https://example.com/inbox";
    const signature = await signMessageRequest(
      new Request(url, { method: "POST", headers }),
      ed.privateKey,
      keyId,
    );
    for (const [name, value] of Object.entries(signature._unsafeUnwrap())) {
      headers.set(name, value);
    }
    const { status, refusals } = await refusalsDuring(() =>
      post(new Request(url, { method: "POST", headers, body })),
    );
    expect(refusals).toEqual([]);
    expect(status).toBe(202);
    expect(await storedContent(`${erin.actorUri}/statuses/ed9421`)).toContain("ed9421");
    expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()?.key.kind).toBe("Ed25519");
  });

  it("reads a key served as its own document when its owner lists it", async () => {
    const dana = await remoteActor("keys-doc-dana", "keys-doc.example", { cache: false });
    const keyId = "https://keys-doc.example/keys/dana";
    const own = await generateAccountKeys();
    const keyDocument = { id: keyId, owner: dana.actorUri, publicKeyPem: own.publicKeyPem };
    const sign = (slug: string) => signedDelivery(create(dana, slug), keyId, own.privateKeyJwk);

    // The owner does not list the key: refused.
    serve({ [keyId]: keyDocument, [dana.actorUri]: actorDocument(dana) });
    expect((await post(sign("unlisted"))).status).toBe(401);

    // The owner lists it by id: the key document's key is taken.
    vi.restoreAllMocks();
    serve({ [keyId]: keyDocument, [dana.actorUri]: actorDocument(dana, { publicKey: [keyId] }) });
    const listed = await refusalsDuring(() => post(sign("listed")));
    expect(listed.refusals).toEqual([]);
    expect(listed.status).toBe(202);
    expect(await storedContent(`${dana.actorUri}/statuses/listed`)).toContain("listed");
  });

  it("drops the keys an actor no longer publishes when it is fetched again", async () => {
    const erin = await remoteActor("keys-refresh-erin", "keys-refresh.example", { cache: false });
    const second = await generateAccountKeys();
    const both = actorDocument(erin, {
      publicKey: [
        { id: `${erin.actorUri}#main-key`, owner: erin.actorUri, publicKeyPem: erin.publicKeyPem },
        {
          id: `${erin.actorUri}#second-key`,
          owner: erin.actorUri,
          publicKeyPem: second.publicKeyPem,
        },
      ],
    });
    serve({ [erin.actorUri]: both });
    expect((await post(erin.delivery(create(erin, "before")))).status).toBe(202);
    expect(
      (await findRemoteActorKey(env.DB, `${erin.actorUri}#second-key`))._unsafeUnwrap(),
    ).toBeDefined();

    vi.restoreAllMocks();
    serve({ [erin.actorUri]: actorDocument(erin) });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect(
      (
        await refreshRemoteActor(env.DB, identity, erin.actorUri, {
          allowHosts: new Set(),
          blockedHosts: CoveredHosts.none,
          fetchSigner: unsignedFetch,
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (await findRemoteActorKey(env.DB, `${erin.actorUri}#second-key`))._unsafeUnwrap(),
    ).toBeUndefined();
    expect(
      (await findRemoteActorKey(env.DB, `${erin.actorUri}#main-key`))._unsafeUnwrap(),
    ).toBeDefined();
  });
});

/** An actor whose document adds an Ed25519 `assertionMethod` Multikey (FEP-521a) to its RSA key. */
const provingActor = async (username: string, host: string) => {
  const remote = await remoteActor(username, host, { cache: false });
  const signer = await ed25519Signer();
  const keyId = `${remote.actorUri}#ed25519-key`;
  const document = actorDocument(remote, {
    assertionMethod: [
      {
        id: keyId,
        type: "Multikey",
        controller: remote.actorUri,
        publicKeyMultibase: signer.publicKeyMultibase,
      },
    ],
  });
  return {
    remote,
    document,
    keyId,
    prove: (activity: Readonly<Record<string, unknown>>, extra?: Record<string, unknown>) =>
      signer.prove(activity, keyId, extra),
  };
};

describe("forwards with FEP-8b32 integrity proofs", () => {
  it("applies a forward its actor proved with an eddsa-jcs-2022 proof", async () => {
    const alice = await provingActor("proof-alice", "proof.example");
    const relay = await remoteActor("proof-relay", "proof-forwarder.example");
    serve({ [alice.remote.actorUri]: alice.document });
    const proved = await alice.prove(create(alice.remote, "proved"));
    expect((await post(relay.forward(proved))).status).toBe(202);
    expect(await storedContent(`${alice.remote.actorUri}/statuses/proved`)).toContain("proved");
  });

  it("drops a proved forward whose content changed after the proof", async () => {
    const alice = await provingActor("proof-tamper-alice", "proof-tamper.example");
    const relay = await remoteActor("proof-tamper-relay", "proof-forwarder.example");
    serve({ [alice.remote.actorUri]: alice.document });
    // Alice's keys are cached by a first forward, so the second is checked
    // against them rather than refused before they are cached.
    expect(
      (await post(relay.forward(await alice.prove(create(alice.remote, "first"))))).status,
    ).toBe(202);
    const proved = await alice.prove(create(alice.remote, "tamper", "<p>original</p>"));
    const object = proved["object"];
    const tampered = {
      ...proved,
      object: { ...(typeof object === "object" ? object : {}), content: "<p>changed</p>" },
    };
    const { status, refusals } = await refusalsDuring(() => post(relay.forward(tampered)));
    expect(status).toBe(202);
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "SignatureMismatch" }]);
    expect(await storedContent(`${alice.remote.actorUri}/statuses/tamper`)).toBeUndefined();
  });

  it("drops a forward proved with another actor's key, or with the actor's RSA key id", async () => {
    const alice = await provingActor("proof-key-alice", "proof-key.example");
    const mallory = await provingActor("proof-key-mallory", "proof-mallory.example");
    const relay = await remoteActor("proof-key-relay", "proof-forwarder.example");
    serve({
      [alice.remote.actorUri]: alice.document,
      [mallory.remote.actorUri]: mallory.document,
    });
    expect(
      (await post(relay.forward(await alice.prove(create(alice.remote, "first"))))).status,
    ).toBe(202);
    const byMallory = await mallory.prove(create(alice.remote, "mallory"));
    const first = await refusalsDuring(() => post(relay.forward(byMallory)));
    expect(first.refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "KeyRejected" }]);

    const underRsaId = await mallory.prove(create(alice.remote, "rsa-id"));
    const proof = underRsaId["proof"];
    const claimed = {
      ...underRsaId,
      proof: {
        ...(typeof proof === "object" ? proof : {}),
        verificationMethod: `${alice.remote.actorUri}#main-key`,
      },
    };
    const second = await refusalsDuring(() => post(relay.forward(claimed)));
    expect(second.refusals).toMatchObject([
      { reason: "UnverifiedForward", detail: "SignatureMismatch" },
    ]);
    expect(await storedContent(`${alice.remote.actorUri}/statuses/mallory`)).toBeUndefined();
    expect(await storedContent(`${alice.remote.actorUri}/statuses/rsa-id`)).toBeUndefined();
  });

  it("drops a forward whose proof expired", async () => {
    const alice = await provingActor("proof-expired-alice", "proof-expired.example");
    const relay = await remoteActor("proof-expired-relay", "proof-forwarder.example");
    serve({ [alice.remote.actorUri]: alice.document });
    const proved = await alice.prove(create(alice.remote, "expired"), {
      expires: new Date(Date.now() - 60_000).toISOString(),
    });
    const { refusals } = await refusalsDuring(() => post(relay.forward(proved)));
    expect(refusals).toMatchObject([{ reason: "UnverifiedForward", detail: "ProofExpired" }]);
  });

  it("falls back to the proof when the Linked Data signature does not verify, and drops that signature", async () => {
    const alice = await provingActor("proof-ld-alice", "proof-ld.example");
    serve({ [alice.remote.actorUri]: alice.document });
    const proved = await alice.prove(create(alice.remote, "ld"));
    const body = {
      ...proved,
      signature: {
        type: "RsaSignature2017",
        creator: `${alice.remote.actorUri}#main-key`,
        created: new Date().toISOString(),
        signatureValue: "AAAA",
      },
    };
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    const verdict = await verifyForwardedActivity(env.DB, identity, body, alice.remote.actorUri, {
      allowHosts: new Set(),
      blockedHosts: CoveredHosts.none,
      fetchSigner: unsignedFetch,
    });
    expect(verdict.kind).toBe("Verified");
    if (verdict.kind === "Verified") {
      expect(verdict.author.actorUri).toBe(alice.remote.actorUri);
      expect(verdict.document).not.toHaveProperty("signature");
      expect(verdict.document).not.toHaveProperty("proof");
      expect(verdict.document).toMatchObject({ id: proved["id"], object: proved["object"] });
    }
  });
});

/** The URLs `fetch` was asked for. */
const fetchedUrls = (spy: ReturnType<typeof serve>): ReadonlyArray<string> =>
  spy.mock.calls.map(([input, init]) => new Request(input, init).url);

const options = () => ({
  allowHosts: new Set<string>(),
  blockedHosts: CoveredHosts.none,
  fetchSigner: unsignedFetch,
});

describe("keys an actor's document names by id (FED-8)", () => {
  it("reads GoToSocial's `/main-key` from its own URL when it caches the actor, and keeps it on a refetch", async () => {
    const gina = await remoteActor("keys-gts-gina", "keys-gts.example", { cache: false });
    const keyId = `${gina.actorUri}/main-key`;
    const own = await generateAccountKeys();
    const publicKey = { id: keyId, owner: gina.actorUri, publicKeyPem: own.publicKeyPem };
    serve({
      [gina.actorUri]: actorDocument(gina, { publicKey }),
      // What GoToSocial serves at a key id: a stub of the actor with its key.
      [keyId]: { id: gina.actorUri, type: "Person", publicKey },
    });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect((await refreshRemoteActor(env.DB, identity, gina.actorUri, options())).isOk()).toBe(
      true,
    );
    expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()?.key.publicKeyPem).toBe(
      own.publicKeyPem,
    );
    expect((await refreshRemoteActor(env.DB, identity, gina.actorUri, options())).isOk()).toBe(
      true,
    );
    expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()?.actor.actorUri).toBe(
      gina.actorUri,
    );
    const send = (slug: string) =>
      post(signedDelivery(create(gina, slug), keyId, own.privateKeyJwk));
    expect((await send("cached")).status).toBe(202);
    expect(await storedContent(`${gina.actorUri}/statuses/cached`)).toContain("cached");
  });

  it("fetches a key named only by its id from the actor's host, keeps it while that host does not answer, and drops it on a 404", async () => {
    const dana = await remoteActor("keys-byid-dana", "keys-byid.example", { cache: false });
    const keyId = "https://keys-byid.example/keys/dana";
    const own = await generateAccountKeys();
    const document = actorDocument(dana, {
      publicKey: [
        { id: `${dana.actorUri}#main-key`, owner: dana.actorUri, publicKeyPem: dana.publicKeyPem },
        keyId,
      ],
    });
    const keyDocument = { id: keyId, owner: dana.actorUri, publicKeyPem: own.publicKeyPem };
    serve({ [dana.actorUri]: document, [keyId]: keyDocument });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    const refresh = () => refreshRemoteActor(env.DB, identity, dana.actorUri, options());
    expect((await refresh()).isOk()).toBe(true);
    expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()?.key.publicKeyPem).toBe(
      own.publicKeyPem,
    );

    // A connection failure stops the refetch, as it raises in Mastodon.
    vi.restoreAllMocks();
    serve({ [dana.actorUri]: { ...document, name: "Renamed" } }, [keyId]);
    expect((await refresh()).isOk()).toBe(true);
    const kept = (await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap();
    expect(kept?.key.publicKeyPem).toBe(own.publicKeyPem);
    expect(kept?.actor.displayName).not.toBe("Renamed");

    // Any answer but a key skips it, and the refetch drops it.
    vi.restoreAllMocks();
    serve({ [dana.actorUri]: document });
    expect((await refresh()).isOk()).toBe(true);
    expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()).toBeUndefined();
    expect(
      (await findRemoteActorKey(env.DB, `${dana.actorUri}#main-key`))._unsafeUnwrap(),
    ).toBeDefined();
  });

  it("reads a Multikey named only by its id when its own document names itself and the actor", async () => {
    const mia = await remoteActor("keys-mk-mia", "keys-mk.example", { cache: false });
    const ed = await ed25519Signer();
    const keyId = "https://keys-mk.example/keys/mia-ed";
    const otherId = "https://keys-mk.example/keys/mia-other";
    const multikey = {
      id: keyId,
      type: "Multikey",
      controller: mia.actorUri,
      publicKeyMultibase: ed.publicKeyMultibase,
    };
    serve({
      [mia.actorUri]: actorDocument(mia, { assertionMethod: [keyId, otherId] }),
      [keyId]: multikey,
      // Served under another id: Mastodon's `fetch_resource` checks the id.
      [otherId]: multikey,
    });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect((await refreshRemoteActor(env.DB, identity, mia.actorUri, options())).isOk()).toBe(true);
    expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()?.key.kind).toBe("Ed25519");
    expect((await findRemoteActorKey(env.DB, otherId))._unsafeUnwrap()).toBeUndefined();
  });

  it("does not fetch a key id on another host than the actor's", async () => {
    const owen = await remoteActor("keys-host-owen", "keys-host.example", { cache: false });
    const own = await generateAccountKeys();
    const ed = await ed25519Signer();
    const named = "https://keys-elsewhere.example/keys/1";
    const embedded = "https://keys-elsewhere.example/keys/2";
    const multikey = "https://keys-elsewhere.example/keys/3";
    const keyDocument = (id: string) => ({
      id,
      owner: owen.actorUri,
      publicKeyPem: own.publicKeyPem,
    });
    const fetched = serve({
      [owen.actorUri]: actorDocument(owen, {
        publicKey: [
          {
            id: `${owen.actorUri}#main-key`,
            owner: owen.actorUri,
            publicKeyPem: owen.publicKeyPem,
          },
          named,
          keyDocument(embedded),
        ],
        assertionMethod: [multikey],
      }),
      [named]: keyDocument(named),
      [embedded]: keyDocument(embedded),
      [multikey]: {
        id: multikey,
        type: "Multikey",
        controller: owen.actorUri,
        publicKeyMultibase: ed.publicKeyMultibase,
      },
    });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect((await refreshRemoteActor(env.DB, identity, owen.actorUri, options())).isOk()).toBe(
      true,
    );
    expect(fetchedUrls(fetched).map((url) => new URL(url).host)).not.toContain(
      "keys-elsewhere.example",
    );
    for (const keyId of [named, embedded, multikey]) {
      expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()).toBeUndefined();
    }
  });

  it("takes no key whose own document names another owner, and fetches none the actor's document gives to another", async () => {
    const victim = await remoteActor("keys-take-victim", "keys-take.example");
    const attacker = await remoteActor("keys-take-attacker", "keys-take.example", {
      cache: false,
    });
    const notMine = "https://keys-take.example/keys/1";
    const givenAway = "https://keys-take.example/keys/2";
    const fetched = serve({
      [attacker.actorUri]: actorDocument(attacker, {
        publicKey: [
          {
            id: `${attacker.actorUri}#main-key`,
            owner: attacker.actorUri,
            publicKeyPem: attacker.publicKeyPem,
          },
          // Under the victim's URI: fetched, and the victim's document owns it.
          {
            id: `${victim.actorUri}#main-key`,
            owner: attacker.actorUri,
            publicKeyPem: attacker.publicKeyPem,
          },
          // Its own document names the victim.
          notMine,
          // Given to the victim here: Mastodon reads no further.
          { id: givenAway, owner: victim.actorUri, publicKeyPem: attacker.publicKeyPem },
        ],
      }),
      [victim.actorUri]: actorDocument(victim),
      [notMine]: { id: notMine, owner: victim.actorUri, publicKeyPem: attacker.publicKeyPem },
      [givenAway]: { id: givenAway, owner: attacker.actorUri, publicKeyPem: attacker.publicKeyPem },
    });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect((await refreshRemoteActor(env.DB, identity, attacker.actorUri, options())).isOk()).toBe(
      true,
    );
    const victimKey = (
      await findRemoteActorKey(env.DB, `${victim.actorUri}#main-key`)
    )._unsafeUnwrap();
    expect(victimKey?.actor.actorUri).toBe(victim.actorUri);
    expect(victimKey?.key.publicKeyPem).toBe(victim.publicKeyPem);
    expect((await findRemoteActorKey(env.DB, notMine))._unsafeUnwrap()).toBeUndefined();
    expect((await findRemoteActorKey(env.DB, givenAway))._unsafeUnwrap()).toBeUndefined();
    expect(fetchedUrls(fetched)).not.toContain(givenAway);
    expect((await post(victim.delivery(create(victim, "still-mine")))).status).toBe(202);
  });

  it("fetches the twenty keys it reads at most six at a time, as Workers opens six connections", async () => {
    const ivy = await remoteActor("keys-pool-ivy", "keys-pool.example", { cache: false });
    const own = await generateAccountKeys();
    const ed = await ed25519Signer();
    const pemIds = Array.from(
      { length: 11 },
      (_, index) => `https://keys-pool.example/rsa/${index}`,
    );
    const multikeyIds = Array.from(
      { length: 11 },
      (_, index) => `https://keys-pool.example/ed/${index}`,
    );
    const documents: Record<string, Record<string, unknown>> = {
      [ivy.actorUri]: actorDocument(ivy, {
        publicKey: pemIds,
        assertionMethod: multikeyIds,
      }),
    };
    for (const id of pemIds) {
      documents[id] = { id, owner: ivy.actorUri, publicKeyPem: own.publicKeyPem };
    }
    for (const id of multikeyIds) {
      documents[id] = {
        id,
        type: "Multikey",
        controller: ivy.actorUri,
        publicKeyMultibase: ed.publicKeyMultibase,
      };
    }
    const served = serve(documents);
    const answer = served.getMockImplementation();
    let open = 0;
    let most = 0;
    served.mockImplementation(async (input, init) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await (answer ?? fetch)(input, init);
      } finally {
        open -= 1;
      }
    });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect((await refreshRemoteActor(env.DB, identity, ivy.actorUri, options())).isOk()).toBe(true);
    expect(most).toBeLessThanOrEqual(6);
    const urls = fetchedUrls(served);
    // Ten of each list are read; the eleventh is never fetched.
    expect(urls).not.toContain(pemIds[10]);
    expect(urls).not.toContain(multikeyIds[10]);
    for (const keyId of [...pemIds.slice(0, 10), ...multikeyIds.slice(0, 10)]) {
      expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()).toBeDefined();
    }
  });

  it("answers an actor Update 503 while a key it names does not answer, and applies it on the retry", async () => {
    const una = await remoteActor("keys-update-una", "keys-update.example", { cache: false });
    const keyId = "https://keys-update.example/keys/una";
    const own = await generateAccountKeys();
    const listing = (overrides: Record<string, unknown> = {}) =>
      actorDocument(una, {
        publicKey: [
          { id: `${una.actorUri}#main-key`, owner: una.actorUri, publicKeyPem: una.publicKeyPem },
          keyId,
        ],
        ...overrides,
      });
    const keyDocument = { id: keyId, owner: una.actorUri, publicKeyPem: own.publicKeyPem };
    serve({ [una.actorUri]: listing(), [keyId]: keyDocument });
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect((await refreshRemoteActor(env.DB, identity, una.actorUri, options())).isOk()).toBe(true);
    const update = {
      "@context": [AS, DATA_INTEGRITY],
      id: `${una.actorUri}#updates/1`,
      type: "Update",
      actor: una.actorUri,
      to: [PUBLIC],
      object: listing({ name: "Updated" }),
    };
    const displayName = async () =>
      (await findRemoteActorByUri(env.DB, una.actorUri))._unsafeUnwrap()?.displayName;

    vi.restoreAllMocks();
    serve({ [una.actorUri]: listing() }, [keyId]);
    const first = await refusalsDuring(() => post(una.delivery(update)));
    expect(first.status).toBe(503);
    expect(first.refusals).toMatchObject([{ reason: "KeyUnavailable" }]);
    expect(await displayName()).not.toBe("Updated");

    vi.restoreAllMocks();
    serve({ [una.actorUri]: listing(), [keyId]: keyDocument });
    expect((await post(una.delivery(update))).status).toBe(202);
    expect(await displayName()).toBe("Updated");
  });

  it("moves a key id to another actor of its host only when the key's own document names that actor", async () => {
    const keyId = "https://keys-move.example/keys/shared";
    const holder = await remoteActor("keys-move-holder", "keys-move.example", { cache: false });
    const taker = await remoteActor("keys-move-taker", "keys-move.example", { cache: false });
    const claimant = await remoteActor("keys-move-claimant", "keys-move.example", {
      cache: false,
    });
    const outsider = await remoteActor("keys-move-outsider", "keys-move-other.example", {
      cache: false,
    });
    const first = await generateAccountKeys();
    const second = await generateAccountKeys();
    const listing = (remote: Remote) =>
      actorDocument(remote, {
        publicKey: [
          {
            id: `${remote.actorUri}#main-key`,
            owner: remote.actorUri,
            publicKeyPem: remote.publicKeyPem,
          },
          keyId,
        ],
      });
    const documents = {
      [holder.actorUri]: listing(holder),
      [taker.actorUri]: listing(taker),
      [claimant.actorUri]: listing(claimant),
      [outsider.actorUri]: listing(outsider),
    };
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    const refresh = (remote: Remote) =>
      refreshRemoteActor(env.DB, identity, remote.actorUri, options());
    const held = async () => (await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap();

    serve({
      ...documents,
      [keyId]: { id: keyId, owner: holder.actorUri, publicKeyPem: first.publicKeyPem },
    });
    expect((await refresh(holder)).isOk()).toBe(true);
    expect((await held())?.actor.actorUri).toBe(holder.actorUri);
    // Another actor of the host lists it, but the key names its holder.
    expect((await refresh(claimant)).isOk()).toBe(true);
    // An actor on another host lists it: never fetched.
    expect((await refresh(outsider)).isOk()).toBe(true);
    expect((await held())?.actor.actorUri).toBe(holder.actorUri);
    expect((await held())?.key.publicKeyPem).toBe(first.publicKeyPem);

    // The host now says the key is the taker's.
    vi.restoreAllMocks();
    serve({
      ...documents,
      [keyId]: { id: keyId, owner: taker.actorUri, publicKeyPem: second.publicKeyPem },
    });
    expect((await refresh(taker)).isOk()).toBe(true);
    expect((await held())?.actor.actorUri).toBe(taker.actorUri);
    expect((await held())?.key.publicKeyPem).toBe(second.publicKeyPem);
    expect(
      (await post(signedDelivery(create(taker, "moved"), keyId, second.privateKeyJwk))).status,
    ).toBe(202);
    expect(await storedContent(`${taker.actorUri}/statuses/moved`)).toContain("moved");
  });

  it("reads an actor only from its own id, not from a document served at another path of its host", async () => {
    const victim = await remoteActor("keys-path-victim", "keys-path.example", { cache: false });
    const evil = await generateAccountKeys();
    const evilKeyId = "https://keys-path.example/uploads/evil.json";
    serve({
      [victim.actorUri]: actorDocument(victim),
      // Anyone who can upload JSON to the host serves this, claiming the actor.
      [evilKeyId]: actorDocument(victim, {
        inbox: "https://keys-path.example/uploads/inbox",
        publicKey: { id: evilKeyId, owner: victim.actorUri, publicKeyPem: evil.publicKeyPem },
      }),
    });
    const { status } = await refusalsDuring(() =>
      post(signedDelivery(create(victim, "forged"), evilKeyId, evil.privateKeyJwk)),
    );
    expect(status).toBe(401);
    expect((await findRemoteActorKey(env.DB, evilKeyId))._unsafeUnwrap()).toBeUndefined();
    expect(await storedContent(`${victim.actorUri}/statuses/forged`)).toBeUndefined();
  });
});

describe("multibase values too long to decode", () => {
  it("refuses a long publicKeyMultibase and proofValue before decoding them", async () => {
    const long = `z${"2".repeat(100_000)}`;
    const started = Date.now();
    expect(multibaseKey(long)).toEqual({ kind: "NoKey" });
    expect(multibaseKey(`z${"r".repeat(3000)}`)).toEqual({ kind: "NoKey" });
    // A character base58 lacks still refuses the actor, however long.
    expect(multibaseKey(`z${"0".repeat(100_000)}`)).toEqual({ kind: "Malformed" });
    const proof = await readIntegrityProof(
      {
        id: "https://long.example/1",
        proof: {
          type: "DataIntegrityProof",
          cryptosuite: "eddsa-jcs-2022",
          verificationMethod: "https://long.example/users/a#k",
          proofPurpose: "assertionMethod",
          proofValue: long,
        },
      },
      new Date(),
    );
    expect(proof._unsafeUnwrapErr()).toEqual({ kind: "UnsupportedProof" });
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("a publicKeyMultibase that is not base58 (FED-8)", () => {
  const badMultikey = (remote: Remote, id: string, controller = remote.actorUri) => ({
    id,
    type: "Multikey",
    controller,
    publicKeyMultibase: "z6Mk0000",
  });

  it("refuses the whole actor, as Multibase.decode raises ArgumentError", async () => {
    const bea = await remoteActor("keys-b58-bea", "keys-b58.example", { cache: false });
    serve({
      [bea.actorUri]: actorDocument(bea, {
        assertionMethod: [badMultikey(bea, `${bea.actorUri}#ed25519-key`)],
      }),
    });
    expect((await post(bea.delivery(create(bea, "refused")))).status).toBe(401);
    expect((await findRemoteActorByUri(env.DB, bea.actorUri))._unsafeUnwrap()).toBeUndefined();
    expect(
      (await findRemoteActorKey(env.DB, `${bea.actorUri}#main-key`))._unsafeUnwrap(),
    ).toBeUndefined();
  });

  it("leaves a cached actor as it was when its document or a Multikey it names by id is not base58", async () => {
    const cal = await remoteActor("keys-b58-cal", "keys-b58c.example", { cache: false });
    const keyId = "https://keys-b58c.example/keys/cal";
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    const refresh = () => refreshRemoteActor(env.DB, identity, cal.actorUri, options());
    serve({ [cal.actorUri]: actorDocument(cal) });
    expect((await refresh()).isOk()).toBe(true);
    const before = (await findRemoteActorByUri(env.DB, cal.actorUri))._unsafeUnwrap();

    for (const document of [
      actorDocument(cal, {
        name: "Embedded",
        assertionMethod: [badMultikey(cal, `${cal.actorUri}#ed25519-key`)],
      }),
      actorDocument(cal, { name: "Named", assertionMethod: [keyId] }),
    ]) {
      vi.restoreAllMocks();
      serve({ [cal.actorUri]: document, [keyId]: badMultikey(cal, keyId) });
      await refresh();
      const after = (await findRemoteActorByUri(env.DB, cal.actorUri))._unsafeUnwrap();
      expect(after?.displayName).toBe(before?.displayName);
    }
    expect(
      (await findRemoteActorKey(env.DB, `${cal.actorUri}#main-key`))._unsafeUnwrap(),
    ).toBeDefined();
  });

  it("reads no further a Multikey of another controller, and skips one Multibase::Error refuses", async () => {
    const dot = await remoteActor("keys-b58-dot", "keys-b58d.example", { cache: false });
    serve({
      [dot.actorUri]: actorDocument(dot, {
        assertionMethod: [
          badMultikey(dot, `${dot.actorUri}#theirs`, "https://keys-b58d.example/users/other"),
          {
            id: `${dot.actorUri}#secp256k1`,
            type: "Multikey",
            controller: dot.actorUri,
            publicKeyMultibase: "zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme",
          },
        ],
      }),
    });
    expect((await post(dot.delivery(create(dot, "taken")))).status).toBe(202);
    expect(
      (await findRemoteActorKey(env.DB, `${dot.actorUri}#secp256k1`))._unsafeUnwrap(),
    ).toBeUndefined();
  });
});

describe("the remote_actors key columns after migration 0152", () => {
  it("holds a key a build from before 0152 still parses, and fails to verify with", async () => {
    const legacy = await remoteActor("keys-legacy", "keys-legacy.example");
    const migrations = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(Reflect.get(env, "TEST_MIGRATIONS"));
    const placeholderWrite = (
      migrations.find((entry) => entry.name.endsWith("_remote_actor_keys.sql"))?.queries ?? []
    ).filter((query) => /UPDATE remote_actors SET public_key_id = actor_uri/.test(query));
    expect(placeholderWrite).toHaveLength(1);
    await env.DB.prepare(placeholderWrite[0] ?? "").run();
    const rows = await env.DB.prepare(
      "SELECT public_key_id, public_key_pem FROM remote_actors WHERE actor_uri = ?",
    )
      .bind(legacy.actorUri)
      .all();
    // The row schema of a build from before 0152.
    const old = z.object({ public_key_id: z.string().min(1), public_key_pem: z.string().min(1) });
    const row = old.parse(rows.results[0]);
    expect(row.public_key_pem).toBe(LEGACY_PUBLIC_KEY_PEM);
    expect(await importRsaPublicKey(row.public_key_pem)).toBeDefined();
    const request = await legacy.delivery(create(legacy, "legacy"));
    expect(
      await verifyInboxRequest(
        request,
        { kind: "Rsa", publicKeyPem: row.public_key_pem },
        await request.clone().text(),
      ),
    ).toBe(false);
    // The worker writes the same placeholder.
    const fetchedAt = IsoInstant.parse(new Date().toISOString())._unsafeUnwrap();
    const actor = RemoteActor.fromFetched({
      actorUri: "https://keys-legacy.example/users/new",
      username: "new",
      domain: "keys-legacy.example",
      inboxUri: "https://keys-legacy.example/users/new/inbox",
      displayName: "new",
      fetchedAt,
    })._unsafeUnwrap();
    expect((await upsertRemoteActor(env.DB, actor, [])).isOk()).toBe(true);
    const written = await env.DB.prepare(
      "SELECT public_key_pem FROM remote_actors WHERE actor_uri = ?",
    )
      .bind(actor.actorUri)
      .first();
    expect(written).toEqual({ public_key_pem: LEGACY_PUBLIC_KEY_PEM });
  });
});
