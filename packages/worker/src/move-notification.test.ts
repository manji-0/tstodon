import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor } from "../test/remote-actor-fixture";
import { notifyFromRemote } from "./notify";
import { RemoteAccountId } from "./remote-account-id";

const NotificationsSchema = z.array(
  z.object({
    type: z.string(),
    account: z.object({ id: z.string() }),
    target: z.object({ id: z.string(), acct: z.string() }).optional(),
  }),
);

describe("move notifications", () => {
  it("name the old account as account and the new one as target", async () => {
    const email = "move-notified@example.com";
    const recipient = await signedInAccount(email);
    const before = await remoteActor("notif-before", "old.example");
    const after = await remoteActor("notif-after", "new.example");

    const sent = await notifyFromRemote(env, {
      accountId: recipient.id,
      actorUri: before.actorUri,
      kind: "move",
      targetAccountId: RemoteAccountId.encode(after.actorUri),
    });
    expect(sent.isOk()).toBe(true);

    const response = await SELF.fetch("https://example.com/api/v1/notifications", {
      headers: await authHeaders(email),
    });
    const parsed = schemaResult(NotificationsSchema)(await response.json());
    if (parsed.isErr()) {
      throw new Error("notifications response schema rejected");
    }
    expect(parsed.value).toHaveLength(1);
    expect(parsed.value[0]?.type).toBe("move");
    expect(parsed.value[0]?.account.id).toBe(RemoteAccountId.encode(before.actorUri));
    expect(parsed.value[0]?.target?.id).toBe(RemoteAccountId.encode(after.actorUri));
    expect(parsed.value[0]?.target?.acct).toBe("notif-after@new.example");
  });
});
