import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { ApiNotification, ApiNotificationPolicy, ApiNotificationRequest } from "@tstodon/api";
import { expectContract } from "../test/api-contract";
import { authHeaders, signedInAccount } from "../test/auth-fixture";

const call = async (email: string, method: string, path: string, body?: unknown) => {
  const response = await SELF.fetch(`https://example.com${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(await authHeaders(email, { admin: email.startsWith("nrb-admin") })),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status, `${method} ${path}`).toBe(200);
  return response.json();
};

/** A recipient with one held request per sender, each holding `perSender` mentions. */
const heldRequests = async (name: string, senders: number, perSender: number) => {
  const recipient = `nrb-${name}-recipient@example.com`;
  const account = await signedInAccount(recipient);
  for (let n = 0; n < senders; n += 1) {
    const sender = `nrb-${name}-sender-${n}@example.com`;
    const senderAccount = await signedInAccount(sender);
    await call(
      "nrb-admin@example.com",
      "POST",
      `/api/v1/admin/accounts/${senderAccount.id}/silence`,
    );
    for (let m = 0; m < perSender; m += 1) {
      await call(sender, "POST", "/api/v1/statuses", {
        status: `@${account.username} held ${m}`,
      });
    }
  }
  const requests = expectContract(
    z.array(ApiNotificationRequest),
    await call(recipient, "GET", "/api/v1/notifications/requests"),
  );
  expect(requests).toHaveLength(senders);
  return { recipient, requests };
};

const notifications = async (email: string) =>
  expectContract(z.array(ApiNotification), await call(email, "GET", "/api/v1/notifications"));

const pending = async (email: string) =>
  expectContract(ApiNotificationPolicy, await call(email, "GET", "/api/v2/notifications/policy"))
    .summary;

describe("POST /api/v1/notifications/requests/accept", () => {
  it("merges every named request's notifications back and remembers the senders", async () => {
    const { recipient, requests } = await heldRequests("accept", 3, 2);
    const [first, second, kept] = requests;
    expect(
      await call(recipient, "POST", "/api/v1/notifications/requests/accept", {
        id: [first?.id, second?.id, "unknown"],
      }),
    ).toEqual({});

    const listed = expectContract(
      z.array(ApiNotificationRequest),
      await call(recipient, "GET", "/api/v1/notifications/requests"),
    );
    expect(listed.map((request) => request.id)).toEqual([kept?.id]);
    const merged = await notifications(recipient);
    const senders = (ids: ReadonlyArray<string | undefined>) =>
      ids.toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(senders(merged.map((notification) => notification.account.id))).toEqual(
      senders([first, first, second, second].map((request) => request?.account.id)),
    );
    expect(await pending(recipient)).toEqual({
      pending_requests_count: 1,
      pending_notifications_count: 2,
    });
  });
});

describe("POST /api/v1/notifications/requests/dismiss", () => {
  it("drops every named request and its notifications, and leaves the rest", async () => {
    const { recipient, requests } = await heldRequests("dismiss", 3, 2);
    const [first, second, kept] = requests;
    expect(
      await call(recipient, "POST", "/api/v1/notifications/requests/dismiss", {
        id: [first?.id, second?.id],
      }),
    ).toEqual({});

    const listed = expectContract(
      z.array(ApiNotificationRequest),
      await call(recipient, "GET", "/api/v1/notifications/requests"),
    );
    expect(listed.map((request) => request.id)).toEqual([kept?.id]);
    expect(await notifications(recipient)).toEqual([]);
    expect(await pending(recipient)).toEqual({
      pending_requests_count: 1,
      pending_notifications_count: 2,
    });
    // Dismissed, not accepted: the next mention from a dismissed sender is held again.
    const dismissedSender = "nrb-dismiss-sender-2@example.com";
    expect((await signedInAccount(dismissedSender)).id).toBe(first?.account.id);
    await call(dismissedSender, "POST", "/api/v1/statuses", {
      status: `@${(await signedInAccount(recipient)).username} again`,
    });
    expect((await pending(recipient)).pending_requests_count).toBe(2);
  });
});

describe("a request whose held notifications are gone", () => {
  it("is not accepted in bulk, as the single route answers 404 for it", async () => {
    const recipient = "nrb-gone-recipient@example.com";
    const account = await signedInAccount(recipient);
    const sender = "nrb-gone-sender@example.com";
    const senderAccount = await signedInAccount(sender);
    await call(
      "nrb-admin@example.com",
      "POST",
      `/api/v1/admin/accounts/${senderAccount.id}/silence`,
    );
    const held = expectContract(
      z.object({ id: z.string() }),
      await call(sender, "POST", "/api/v1/statuses", { status: `@${account.username} soon gone` }),
    );
    const [request] = expectContract(
      z.array(ApiNotificationRequest),
      await call(recipient, "GET", "/api/v1/notifications/requests"),
    );
    // As a remote sender's Delete does (`deleteRemoteNotifications`): the
    // held notification goes, cascading its request row, and the group stays.
    await env.DB.prepare("DELETE FROM notifications WHERE status_id = ?").bind(held.id).run();
    const single = await SELF.fetch(
      `https://example.com/api/v1/notifications/requests/${request?.id}/accept`,
      { method: "POST", headers: await authHeaders(recipient) },
    );
    expect(single.status).toBe(404);
    await single.body?.cancel();
    expect(
      await call(recipient, "POST", "/api/v1/notifications/requests/accept", { id: [request?.id] }),
    ).toEqual({});

    await call(sender, "POST", "/api/v1/statuses", { status: `@${account.username} held again` });
    expect((await pending(recipient)).pending_requests_count).toBe(1);
  });
});
