import { createExecutionContext, env } from "cloudflare:test";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { Hono } from "hono";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ed25519Signer } from "../test/integrity-proof-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { unsignedFetch } from "./federated-fetch";
import { importRsaPublicKey, signInboxRequest, verifyInboxRequest } from "./http-signature";
import { readIntegrityProof } from "./integrity-proof";
import { verifyForwardedActivity } from "./inbox-forward";
import { forgetInboxRefusalWindows } from "./inbox-refusal";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { refreshRemoteActor } from "./remote-actor-fetch";
import { multibaseKey } from "./multibase";
import { findRemoteActorKey, LEGACY_PUBLIC_KEY_PEM, upsertRemoteActor } from "./remote-actor-store";
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

const options = () => ({
  allowHosts: new Set<string>(),
  blockedHosts: new Set<never>(),
  fetchSigner: unsignedFetch,
});

describe("keys an actor's document cannot claim", () => {
  it("reads GoToSocial's `/main-key` from its own URL, as Mastodon does, also after a refetch drops it", async () => {
    const gina = await remoteActor("keys-gts-gina", "keys-gts.example", { cache: false });
    const keyId = `${gina.actorUri}/main-key`;
    const own = await generateAccountKeys();
    const publicKey = { id: keyId, owner: gina.actorUri, publicKeyPem: own.publicKeyPem };
    serve({
      [gina.actorUri]: actorDocument(gina, { publicKey }),
      // What GoToSocial serves at a key id: a stub of the actor with its key.
      [keyId]: { id: gina.actorUri, type: "Person", publicKey },
    });
    const send = (slug: string) =>
      post(signedDelivery(create(gina, slug), keyId, own.privateKeyJwk));
    expect((await send("first")).status).toBe(202);
    const identity = parseInstanceIdentity(env)._unsafeUnwrap();
    expect((await refreshRemoteActor(env.DB, identity, gina.actorUri, options())).isOk()).toBe(
      true,
    );
    expect((await findRemoteActorKey(env.DB, keyId))._unsafeUnwrap()).toBeUndefined();
    expect((await send("second")).status).toBe(202);
    expect(await storedContent(`${gina.actorUri}/statuses/second`)).toContain("second");
  });

  it("does not let an actor's document take a key id on its host that is not its own", async () => {
    const victim = await remoteActor("keys-take-victim", "keys-take.example");
    const attacker = await remoteActor("keys-take-attacker", "keys-take.example", {
      cache: false,
    });
    serve({
      [attacker.actorUri]: actorDocument(attacker, {
        publicKey: [
          {
            id: `${attacker.actorUri}#main-key`,
            owner: attacker.actorUri,
            publicKeyPem: attacker.publicKeyPem,
          },
          {
            id: `${victim.actorUri}#main-key`,
            owner: attacker.actorUri,
            publicKeyPem: attacker.publicKeyPem,
          },
          {
            id: "https://keys-take.example/keys/1",
            owner: attacker.actorUri,
            publicKeyPem: attacker.publicKeyPem,
          },
        ],
      }),
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
    expect(
      (await findRemoteActorKey(env.DB, "https://keys-take.example/keys/1"))._unsafeUnwrap(),
    ).toBeUndefined();
    expect((await post(victim.delivery(create(victim, "still-mine")))).status).toBe(202);
  });

  it("leaves a key with the actor that holds it when another actor's keys are written", async () => {
    const holder = await remoteActor("keys-move-holder", "keys-move.example");
    const other = await remoteActor("keys-move-other", "keys-move.example");
    const otherActor = (
      await findRemoteActorKey(env.DB, `${other.actorUri}#main-key`)
    )._unsafeUnwrap();
    if (otherActor === undefined) {
      throw new Error("fixture actor not cached");
    }
    const written = await upsertRemoteActor(env.DB, otherActor.actor, [
      otherActor.key,
      { kind: "Rsa", keyId: `${holder.actorUri}#main-key`, publicKeyPem: other.publicKeyPem },
    ]);
    expect(written.isOk()).toBe(true);
    const held = (await findRemoteActorKey(env.DB, `${holder.actorUri}#main-key`))._unsafeUnwrap();
    expect(held?.actor.actorUri).toBe(holder.actorUri);
    expect(held?.key.publicKeyPem).toBe(holder.publicKeyPem);
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
    expect(multibaseKey(long)).toBeUndefined();
    expect(multibaseKey(`z${"r".repeat(3000)}`)).toBeUndefined();
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

describe("the remote_actors key columns after migration 0151", () => {
  it("holds a key a build from before 0151 still parses, and fails to verify with", async () => {
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
    // The row schema of a build from before 0151.
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
