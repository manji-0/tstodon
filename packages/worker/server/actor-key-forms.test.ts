import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ed25519Signer } from "../test/integrity-proof-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { unsignedFetch } from "./federated-fetch";
import { signInboxRequest } from "./http-signature";
import { verifyForwardedActivity } from "./inbox-forward";
import { forgetInboxRefusalWindows } from "./inbox-refusal";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { refreshRemoteActor } from "./remote-actor-fetch";
import { findRemoteActorKey } from "./remote-actor-store";
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

/** `fetch` answering `documents` by URL (the fragment dropped), 404 for anything else. */
const serve = (documents: Readonly<Record<string, Readonly<Record<string, unknown>>>>) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    url.hash = "";
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
          blockedHosts: new Set(),
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
      blockedHosts: new Set(),
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
