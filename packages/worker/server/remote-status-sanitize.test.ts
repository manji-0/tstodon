import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { IsoInstant, RemoteActor } from "@tstodon/domain";
import { nowIso } from "./clock";
import { generateAccountKeys } from "./keys";
import { parseInstanceIdentity } from "./runtime-config";
import { upsertRemoteActor } from "./remote-actor-store";
import { persistRemoteObject } from "./remote-status-persist";

const StatusSchema = z.object({
  content: z.string(),
  url: z.string().nullable(),
  media_attachments: z.array(z.object({ url: z.string() })),
});

const hostileActor = async (): Promise<RemoteActor> => {
  const keys = await generateAccountKeys();
  const fetchedAt = IsoInstant.parse(nowIso());
  if (fetchedAt.isErr()) {
    throw new Error("clock");
  }
  const actorUri = "https://hostile.example/users/mallory";
  const actor = RemoteActor.fromFetched({
    actorUri,
    username: "mallory",
    domain: "hostile.example",
    inboxUri: `${actorUri}/inbox`,
    publicKeyId: `${actorUri}#main-key`,
    publicKeyPem: keys.publicKeyPem,
    displayName: "mallory",
    fetchedAt: fetchedAt.value,
  });
  if (actor.isErr()) {
    throw new Error("actor fixture rejected");
  }
  expect((await upsertRemoteActor(env.DB, actor.value)).isOk()).toBe(true);
  return actor.value;
};

describe("remote status HTML", () => {
  it("serves another server's post without script, handlers, or javascript: links", async () => {
    const identity = parseInstanceIdentity(env);
    if (identity.isErr()) {
      throw new Error("identity");
    }
    const actor = await hostileActor();
    const persisted = await persistRemoteObject(env, identity.value, actor, {
      id: `${actor.actorUri}/statuses/1`,
      type: "Note",
      attributedTo: actor.actorUri,
      content:
        '<p onmouseover="alert(1)">hello<script>alert(2)</script> <img src=x onerror=alert(3)>' +
        '<a href="javascript:alert(4)">click</a> <a href="https://ok.example/">ok</a></p>',
      url: "javascript:alert(5)",
      published: new Date().toISOString(),
      to: ["https://www.w3.org/ns/activitystreams#Public"],
      attachment: [
        { type: "Document", mediaType: "image/png", url: "javascript:alert(6)" },
        { type: "Document", mediaType: "image/png", url: "https://hostile.example/a.png" },
      ],
    });
    if (persisted.isErr() || !persisted.value) {
      throw new Error("remote post rejected");
    }

    const response = await SELF.fetch(`https://example.com/api/v1/statuses/${persisted.value.id}`);
    expect(response.status).toBe(200);
    const parsed = schemaResult(StatusSchema)(await response.json());
    if (parsed.isErr()) {
      throw new Error("response schema rejected");
    }
    expect(parsed.value.content).toBe(
      '<p>hello <a rel="nofollow noopener" target="_blank">click</a> ' +
        '<a href="https://ok.example/" rel="nofollow noopener" target="_blank">ok</a></p>',
    );
    expect(parsed.value.url).toBe(actor.actorUri + "/statuses/1");
    expect(parsed.value.media_attachments.map((media) => media.url)).toEqual([
      "https://hostile.example/a.png",
    ]);
  });
});
