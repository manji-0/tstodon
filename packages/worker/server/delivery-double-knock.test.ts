import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { withHostAddresses } from "../test/host-resolver-fixture";
import { prepareInboxDelivery } from "./delivery";
import { parseRequestSignature, verifyInboxRequest } from "./http-signature";
import { instanceActorKeys } from "./instance-actor";
import { insertOutboundActivity } from "./outbox-store";
import { clearDnsVerdictCache } from "./remote-dns";

/**
 * Mastodon v4.7.5's `Request#perform` sends a signed request with a
 * draft-cavage signature, and once more with an RFC 9421 message signature
 * when that is answered 400 or 401 (FED-9). tstodon's deliveries do the same.
 */

const INBOX = "https://knock.example/inbox";

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

type Seen = Readonly<{ scheme: string; verified: boolean }>;

/** An inbox that answers each signature scheme with its own status, verifying what it gets. */
const serveInbox = (statuses: Readonly<{ Cavage: number; MessageSignature: number }>): Seen[] => {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const scheme = parseRequestSignature(request.headers).map((parsed) => parsed.kind);
    const publicKeyPem = (await instanceActorKeys(env.DB))._unsafeUnwrap().publicKeyPem;
    const verified = await verifyInboxRequest(
      request.clone(),
      { kind: "Rsa", publicKeyPem },
      await request.text(),
    );
    const kind = scheme.unwrapOr("Unsigned");
    seen.push({ scheme: kind, verified });
    return new Response(null, { status: kind === "Unsigned" ? 401 : statuses[kind] });
  });
  return seen;
};

/** One delivery attempt to {@link INBOX}; its outcome's kind. */
const deliver = async (): Promise<string | undefined> => {
  let outcome: string | undefined;
  await withHostAddresses({}, async () => {
    const post = await prepareInboxDelivery(env, await queuedActivity());
    outcome = (await post(INBOX)).outcome.kind;
  });
  return outcome;
};

describe("delivery double-knocking (FED-9)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearDnsVerdictCache();
  });

  it("sends an RFC 9421 delivery when draft-cavage is answered 401, and counts its answer", async () => {
    const seen = serveInbox({ Cavage: 401, MessageSignature: 202 });
    const outcome = await deliver();
    expect(seen).toEqual([
      { scheme: "Cavage", verified: true },
      { scheme: "MessageSignature", verified: true },
    ]);
    expect(outcome).toBe("Success");
  });

  it("knocks again on 400 too, and only once", async () => {
    const seen = serveInbox({ Cavage: 400, MessageSignature: 401 });
    const outcome = await deliver();
    expect(seen.map((entry) => entry.scheme)).toEqual(["Cavage", "MessageSignature"]);
    expect(outcome).not.toBe("Success");
  });

  it.each([202, 403, 404, 500])(
    "does not knock again when draft-cavage is answered %i",
    async (status) => {
      const seen = serveInbox({ Cavage: status, MessageSignature: 202 });
      await deliver();
      expect(seen.map((entry) => entry.scheme)).toEqual(["Cavage"]);
    },
  );
});
