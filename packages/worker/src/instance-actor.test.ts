import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { deliverTarget } from "../test/delivery-fixture";
import { enqueueInstanceActorActivity } from "./delivery";
import { verifyInboxRequest } from "./http-signature";

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const ActorSchema = z.object({
  id: z.string(),
  type: z.string(),
  preferredUsername: z.string(),
  inbox: z.string(),
  publicKey: z.object({ id: z.string(), owner: z.string(), publicKeyPem: z.string() }),
});

const instanceActor = async () => {
  const response = await SELF.fetch("https://example.com/actor", {
    headers: { accept: "application/activity+json" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/activity+json");
  return read(ActorSchema, await response.json());
};

describe("instance actor", () => {
  it("serves an Application actor whose key stays the same", async () => {
    const first = await instanceActor();
    expect(first).toMatchObject({
      id: "https://example.com/actor",
      type: "Application",
      preferredUsername: "example.com",
      inbox: "https://example.com/actor/inbox",
      publicKey: { id: "https://example.com/actor#main-key", owner: "https://example.com/actor" },
    });
    expect((await instanceActor()).publicKey.publicKeyPem).toBe(first.publicKey.publicKeyPem);
  });

  it("is found by WebFinger as acct:<domain>@<domain>", async () => {
    const response = await SELF.fetch(
      "https://example.com/.well-known/webfinger?resource=acct:example.com@example.com",
    );
    expect(response.status).toBe(200);
    const webfinger = read(
      z.object({ links: z.array(z.object({ rel: z.string(), href: z.string() })) }),
      await response.json(),
    );
    expect(webfinger.links).toContainEqual({ rel: "self", href: "https://example.com/actor" });
  });

  it("signs the activities it sends with its own key", async () => {
    const inbox = "https://remote.example/users/signed-check/inbox";
    const activity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://example.com/actor#signed-check",
      type: "Flag",
      actor: "https://example.com/actor",
      object: ["https://remote.example/users/signed-check"],
    };
    expect((await enqueueInstanceActorActivity(env, "Flag", activity, inbox)).isOk()).toBe(true);
    const row = await env.DB.prepare(
      `SELECT a.id FROM outbound_activities a JOIN outbox_deliveries d ON d.activity_id = a.id
       WHERE a.account_id IS NULL AND d.inbox_url = ?`,
    )
      .bind(inbox)
      .first<{ id: string }>();
    const request = await deliverTarget(row?.id ?? "", inbox);
    expect(request.url).toBe(inbox);
    expect(request.headers.get("Signature")).toContain(
      'keyId="https://example.com/actor#main-key"',
    );
    const actor = await instanceActor();
    expect(
      await verifyInboxRequest(request, actor.publicKey.publicKeyPem, await request.text()),
    ).toBe(true);
  });
});
