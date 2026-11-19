import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { testIdentity } from "../test/domain-fixture";
import { meter, meterWork, patchD1, resetMeter, settle } from "../test/meter";
import { notificationDisposition } from "./notification-policy";

// Mastodon reads whether a direct mention answers the recipient only when
// the answer can change the outcome: for a sender the recipient does not
// follow, under a policy that does not accept private mentions.

const post = async (email: string, path: string, body: Record<string, unknown> = {}) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
};

/** The D1 statements one disposition of a notification from `senderId` costs. */
const statements = async (
  recipientId: string,
  senderId: string,
  kind: string,
  statusId: string,
): Promise<number> => {
  await settle();
  resetMeter();
  const disposition = await meterWork(() =>
    notificationDisposition(env.DB, testIdentity(), {
      recipientId,
      senderId,
      kind,
      statusId,
    }),
  );
  expect(disposition.isOk()).toBe(true);
  return meter.tally.statements;
};

beforeAll(() => {
  patchD1();
});

describe("the notification policy's cost for a direct mention", () => {
  it("skips the thread walk when the recipient follows the sender", async () => {
    const recipient = await signedInAccount("np-cost-recipient@example.com");
    const friend = await signedInAccount("np-cost-friend@example.com");
    const stranger = await signedInAccount("np-cost-stranger@example.com");
    await post("np-cost-recipient@example.com", `/api/v1/accounts/${friend.id}/follow`);
    const direct = async (email: string): Promise<string> =>
      z.object({ id: z.string() }).parse(
        await post(email, "/api/v1/statuses", {
          status: `@${recipient.username} hello`,
          visibility: "direct",
        }),
      ).id;
    const fromFriend = await direct("np-cost-friend@example.com");
    const fromStranger = await direct("np-cost-stranger@example.com");

    // A favourite has no thread to walk: the baseline for each sender.
    expect(await statements(recipient.id, friend.id, "mention", fromFriend)).toBe(
      await statements(recipient.id, friend.id, "favourite", fromFriend),
    );
    expect(await statements(recipient.id, stranger.id, "mention", fromStranger)).toBeGreaterThan(
      await statements(recipient.id, stranger.id, "favourite", fromStranger),
    );
  });

  it("skips the thread walk when the policy accepts private mentions", async () => {
    const recipient = await signedInAccount("np-cost-accepting@example.com");
    const stranger = await signedInAccount("np-cost-accepted-stranger@example.com");
    const response = await SELF.fetch("https://example.com/api/v2/notifications/policy", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("np-cost-accepting@example.com")),
      },
      body: JSON.stringify({ for_private_mentions: "accept" }),
    });
    expect(response.status).toBe(200);
    const status = z.object({ id: z.string() }).parse(
      await post("np-cost-accepted-stranger@example.com", "/api/v1/statuses", {
        status: `@${recipient.username} hello`,
        visibility: "direct",
      }),
    );

    expect(await statements(recipient.id, stranger.id, "mention", status.id)).toBe(
      await statements(recipient.id, stranger.id, "favourite", status.id),
    );
  });
});
