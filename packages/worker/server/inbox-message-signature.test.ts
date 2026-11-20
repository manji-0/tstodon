import { createExecutionContext, env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { contentDigestHeader } from "./http-message-signature";
import { forgetInboxRefusalWindows } from "./inbox-refusal";
import { postInbox } from "./routes/activitypub";

/**
 * Deliveries signed with RFC 9421 HTTP message signatures, as Mastodon
 * v4.7.5 sends one once a draft-cavage delivery is answered 400 or 401
 * (FED-9). The inbox runs in this isolate so its refusal log can be read.
 */

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const app = new Hono<{ Bindings: Env }>();
app.post("/inbox", postInbox);

const post = async (request: Request | Promise<Request>): Promise<Response> =>
  app.request(await request, undefined, env, createExecutionContext());

let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
  // No remote answers: a key that is not cached cannot be fetched.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
});

afterEach(() => {
  vi.restoreAllMocks();
  forgetInboxRefusalWindows();
});

/** The `InboxRefused` lines logged while `run` posts. */
const refusalsDuring = async (run: () => Promise<Response>) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const response = await run();
  const refusals = warn.mock.calls
    .map(([line]) => (typeof line === "string" ? JSON.parse(line) : undefined))
    .filter((event) => event?.kind === "InboxRefused");
  warn.mockRestore();
  return { status: response.status, refusals };
};

const create = (author: Remote, slug: string) => ({
  id: `${author.actorUri}/statuses/${slug}/activity`,
  type: "Create",
  to: [PUBLIC],
  object: {
    id: `${author.actorUri}/statuses/${slug}`,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
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

/** `request` with `headers` changed. */
const altered = async (
  request: Request | Promise<Request>,
  headers: Record<string, string | null>,
  body?: string,
): Promise<Request> => {
  const original = await request;
  const changed = new Headers(original.headers);
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) {
      changed.delete(name);
    } else {
      changed.set(name, value);
    }
  }
  return new Request(original.url, {
    method: original.method,
    headers: changed,
    body: body ?? (await original.text()),
  });
};

describe("an RFC 9421 delivery (FED-9)", () => {
  it("is accepted from a cached actor, as Mastodon double-knocks with it", async () => {
    const alice = await remoteActor("rfc9421-alice", "rfc9421.example");
    const delivery = await alice.delivery(create(alice, "accepted"), undefined, "MessageSignature");
    expect(delivery.headers.get("Signature-Input")).toMatch(
      /^sig1=\("@method" "@target-uri" "content-digest"\);created=\d+;keyid="https:\/\/rfc9421\.example\/users\/rfc9421-alice#main-key"$/,
    );
    expect(delivery.headers.get("Digest")).toBeNull();
    const { status, refusals } = await refusalsDuring(() => post(delivery));
    expect(refusals).toEqual([]);
    expect(status).toBe(202);
    expect(await storedContent(`${alice.actorUri}/statuses/accepted`)).toContain("accepted");
  });

  it("is refused when the body is not the one Content-Digest names, or that is not a dictionary", async () => {
    const bob = await remoteActor("rfc9421-bob", "rfc9421.example");
    const signed = bob.delivery(create(bob, "tampered"), undefined, "MessageSignature");
    const other = JSON.stringify({ ...create(bob, "other"), actor: bob.actorUri });
    const tampered = await refusalsDuring(async () => post(altered(signed, {}, other)));
    expect(tampered.status).toBe(401);
    expect(tampered.refusals).toMatchObject([{ reason: "DigestMismatch" }]);

    // A digest of the new body is not the one the signature covers.
    const redigested = await refusalsDuring(async () =>
      post(altered(signed, { "Content-Digest": await contentDigestHeader(other) }, other)),
    );
    expect(redigested.status).toBe(401);
    expect(redigested.refusals).toMatchObject([{ reason: "SignatureMismatch" }]);

    // Mastodon answers a Content-Digest that does not parse with 400 (`MalformedHeaderError`).
    const malformed = await refusalsDuring(async () =>
      post(altered(signed, { "Content-Digest": "SHA-256=abc" })),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.refusals).toMatchObject([{ reason: "MalformedContentDigest" }]);
    expect(await storedContent(`${bob.actorUri}/statuses/tampered`)).toBeUndefined();
  });

  it("is refused when it does not cover @target-uri or content-digest, or names another target", async () => {
    const carol = await remoteActor("rfc9421-carol", "rfc9421.example");
    const signed = await carol.delivery(create(carol, "weak"), undefined, "MessageSignature");
    const input = signed.headers.get("Signature-Input") ?? "";
    const untargeted = await refusalsDuring(() =>
      post(altered(signed.clone(), { "Signature-Input": input.replace(' "@target-uri"', "") })),
    );
    expect(untargeted.status).toBe(401);
    expect(untargeted.refusals).toMatchObject([{ reason: "TargetNotSigned" }]);

    const undigested = await refusalsDuring(() =>
      post(altered(signed.clone(), { "Signature-Input": input.replace(' "content-digest"', "") })),
    );
    expect(undigested.status).toBe(401);
    expect(undigested.refusals).toMatchObject([{ reason: "DigestNotSigned" }]);

    // Signed for the shared inbox, sent to another URL.
    const elsewhere = signed.clone();
    const redirected = await refusalsDuring(() =>
      post(
        new Request("https://example.com/inbox?again=1", {
          method: "POST",
          headers: elsewhere.headers,
          body: elsewhere.body,
        }),
      ),
    );
    expect(redirected.status).toBe(401);
    expect(redirected.refusals).toMatchObject([{ reason: "SignatureMismatch" }]);
    expect(await storedContent(`${carol.actorUri}/statuses/weak`)).toBeUndefined();
  });

  it("is refused once its created time is past Mastodon's window, before any key is fetched", async () => {
    const dave = await remoteActor("rfc9421-dave", "rfc9421-late.example", { cache: false });
    const late = new Date(Date.now() - 66 * 60 * 1000);
    const { status, refusals } = await refusalsDuring(async () =>
      post(dave.delivery(create(dave, "late"), late, "MessageSignature")),
    );
    expect(status).toBe(401);
    expect(refusals).toMatchObject([{ reason: "SignatureExpired", detail: "past" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is refused when its keyid is on a suspended domain, without fetching it", async () => {
    await env.DB.prepare(
      "INSERT INTO domain_blocks (id, domain, severity) VALUES ('rfc9421-block', 'rfc9421-suspended.example', 'suspend')",
    ).run();
    const eve = await remoteActor("rfc9421-eve", "rfc9421-suspended.example", { cache: false });
    const { status, refusals } = await refusalsDuring(async () =>
      post(eve.delivery(create(eve, "blocked"), undefined, "MessageSignature")),
    );
    expect(status).toBe(403);
    expect(refusals).toMatchObject([{ reason: "DomainSuspended" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is unsigned without Signature, and refused with two signatures, as linzer refuses them", async () => {
    const frank = await remoteActor("rfc9421-frank", "rfc9421.example");
    const signed = await frank.delivery(create(frank, "two"), undefined, "MessageSignature");
    const unsigned = await refusalsDuring(() => post(altered(signed.clone(), { Signature: null })));
    expect(unsigned.status).toBe(401);
    expect(unsigned.refusals).toMatchObject([{ reason: "MissingSignature" }]);

    const input = signed.headers.get("Signature-Input") ?? "";
    const signature = signed.headers.get("Signature") ?? "";
    const twice = await refusalsDuring(() =>
      post(
        altered(signed.clone(), {
          "Signature-Input": `${input}, ${input.replace("sig1=", "sig2=")}`,
          Signature: `${signature}, ${signature.replace("sig1=", "sig2=")}`,
        }),
      ),
    );
    expect(twice.status).toBe(401);
    expect(twice.refusals).toMatchObject([
      { reason: "MissingSignature", detail: "MultipleSignatures" },
    ]);
  });
});
