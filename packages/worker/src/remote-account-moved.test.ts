import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { remoteActor } from "../test/remote-actor-fixture";
import { RemoteAccountId } from "./remote-account-id";
import { setRemoteActorMovedTo } from "./remote-actor-store";

const AccountSchema = z.object({
  id: z.string(),
  moved: z.object({ id: z.string(), acct: z.string() }).optional(),
});

const account = async (actorUri: string) => {
  const response = await SELF.fetch(
    `https://example.com/api/v1/accounts/${RemoteAccountId.encode(actorUri)}`,
  );
  const parsed = schemaResult(AccountSchema)(await response.json());
  if (parsed.isErr()) {
    throw new Error("account response schema rejected");
  }
  return parsed.value;
};

describe("a remote account that moved", () => {
  it("renders the account it moved to as `moved`", async () => {
    const before = await remoteActor("moved-before", "old.example");
    const after = await remoteActor("moved-after", "new.example");
    expect((await account(before.actorUri)).moved).toBeUndefined();

    expect((await setRemoteActorMovedTo(env.DB, before.actorUri, after.actorUri)).isOk()).toBe(
      true,
    );

    const moved = (await account(before.actorUri)).moved;
    expect(moved?.id).toBe(RemoteAccountId.encode(after.actorUri));
    expect(moved?.acct).toBe("moved-after@new.example");
    expect((await account(after.actorUri)).moved).toBeUndefined();
  });
});
