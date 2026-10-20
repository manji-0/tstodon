import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { accessAuthHeaders } from "../test/access-jwt-fixture";
import { MastodonAccountPreviewSchema } from "./schemas";

const auth = (email: string, admin = false): Promise<Record<string, string>> =>
  accessAuthHeaders(email, { admin });

const json = async (
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  return { status: response.status, body };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const PolicySchema = z.object({
  for_not_following: z.string(),
  for_not_followers: z.string(),
  for_new_accounts: z.string(),
  for_private_mentions: z.string(),
  for_limited_accounts: z.string(),
  summary: z.object({
    pending_requests_count: z.number(),
    pending_notifications_count: z.number(),
  }),
});

const RequestSchema = z.object({
  id: z.string().min(1),
  notifications_count: z.string(),
  account: MastodonAccountPreviewSchema.nullable(),
  last_status: z.object({ id: z.string().min(1) }).nullable(),
});

const credentials = async (email: string): Promise<{ id: string; username: string }> => {
  const response = await json("/api/v1/accounts/verify_credentials", {
    headers: await auth(email),
  });
  const account = read(MastodonAccountPreviewSchema, response.body);
  return { id: account.id, username: account.username };
};

const postStatus = async (email: string, body: Record<string, unknown>): Promise<void> => {
  const response = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};

const patchPolicy = async (
  email: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  json("/api/v2/notifications/policy", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(await auth(email)) },
    body: JSON.stringify(body),
  });

const notifications = async (email: string): Promise<unknown[]> => {
  const response = await json("/api/v1/notifications", { headers: await auth(email) });
  expect(response.status).toBe(200);
  return read(z.array(z.unknown()), response.body);
};

describe("notification policy", () => {
  it("serves Mastodon's defaults and stores updates", async () => {
    const email = "policy-owner@example.com";
    const initial = await json("/api/v2/notifications/policy", { headers: await auth(email) });
    expect(initial.status).toBe(200);
    const policy = read(PolicySchema, initial.body);
    expect(policy.for_private_mentions).toBe("drop");
    expect(policy.for_limited_accounts).toBe("filter");
    expect(policy.summary.pending_requests_count).toBe(0);

    const updated = await patchPolicy(email, { for_not_following: "filter" });
    expect(updated.status).toBe(200);
    expect(read(PolicySchema, updated.body).for_not_following).toBe("filter");

    // Legacy boolean form is accepted too.
    const legacy = await patchPolicy(email, { filter_not_followers: true });
    expect(read(PolicySchema, legacy.body).for_not_followers).toBe("filter");

    expect((await json("/api/v2/notifications/policy")).status).toBe(401);
  });

  it("drops a private mention from a stranger by default", async () => {
    const recipientEmail = "policy-recipient@example.com";
    const recipient = await credentials(recipientEmail);
    await credentials("policy-stranger@example.com");

    await postStatus("policy-stranger@example.com", {
      status: `@${recipient.username} secret hello`,
      visibility: "direct",
    });
    expect(await notifications(recipientEmail)).toHaveLength(0);
  });

  it("holds a mention from a silenced account as a request and merges it on accept", async () => {
    const recipientEmail = "policy-request-recipient@example.com";
    const senderEmail = "policy-request-sender@example.com";
    const recipient = await credentials(recipientEmail);
    const sender = await credentials(senderEmail);

    await postStatus(senderEmail, { status: `@${recipient.username} hello there` });
    expect(await notifications(recipientEmail)).toHaveLength(1);

    // Silencing the sender makes the default `for_limited_accounts: filter`
    // hold their next notification back.
    const silenced = await json(`/api/v1/admin/accounts/${sender.id}/silence`, {
      method: "POST",
      headers: await auth("policy-admin@example.com", true),
    });
    expect(silenced.status).toBe(200);
    await postStatus(senderEmail, { status: `@${recipient.username} second hello` });
    expect(await notifications(recipientEmail)).toHaveLength(1);

    const requests = await json("/api/v1/notifications/requests", {
      headers: await auth(recipientEmail),
    });
    expect(requests.status).toBe(200);
    const held = read(z.array(RequestSchema), requests.body);
    expect(held).toHaveLength(1);
    expect(held[0]?.account?.id).toBe(sender.id);
    // The held status is the second mention, not the first (already delivered).
    const heldStatus = await json(`/api/v1/statuses/${held[0]?.last_status?.id ?? ""}`, {
      headers: await auth(recipientEmail),
    });
    expect(read(z.object({ content: z.string() }), heldStatus.body).content).toContain(
      "second hello",
    );
    expect(held[0]?.notifications_count).toBe("1");
    expect(held[0]?.last_status?.id).toBeDefined();
    // The request has an id of its own, not the sender's account id.
    expect(held[0]?.id).not.toBe(sender.id);

    const summary = await json("/api/v2/notifications/policy", {
      headers: await auth(recipientEmail),
    });
    expect(read(PolicySchema, summary.body).summary.pending_requests_count).toBe(1);

    const accepted = await json("/api/v1/notifications/requests/merged");
    expect(read(z.object({ merged: z.boolean() }), accepted.body).merged).toBe(false);

    const accept = await json(`/api/v1/notifications/requests/${held[0]?.id ?? ""}/accept`, {
      method: "POST",
      headers: await auth(recipientEmail),
    });
    expect(accept.status).toBe(200);
    // The held notification merges back and the sender is remembered.
    expect(await notifications(recipientEmail)).toHaveLength(2);
    const afterAccept = await json("/api/v1/notifications/requests", {
      headers: await auth(recipientEmail),
    });
    expect(read(z.array(RequestSchema), afterAccept.body)).toHaveLength(0);
    await postStatus(senderEmail, { status: `@${recipient.username} third hello` });
    expect(await notifications(recipientEmail)).toHaveLength(3);
  });

  it("discards held notifications on dismiss", async () => {
    const recipientEmail = "policy-dismiss-recipient@example.com";
    const senderEmail = "policy-dismiss-sender@example.com";
    const recipient = await credentials(recipientEmail);
    const sender = await credentials(senderEmail);

    await json(`/api/v1/admin/accounts/${sender.id}/silence`, {
      method: "POST",
      headers: await auth("policy-admin2@example.com", true),
    });
    await postStatus(senderEmail, { status: `@${recipient.username} held back` });

    const before = await json("/api/v1/notifications/requests", {
      headers: await auth(recipientEmail),
    });
    expect(read(z.array(RequestSchema), before.body)).toHaveLength(1);

    const dismissed = await json(`/api/v1/notifications/requests/${sender.id}/dismiss`, {
      method: "POST",
      headers: await auth(recipientEmail),
    });
    expect(dismissed.status).toBe(200);
    expect(await notifications(recipientEmail)).toHaveLength(0);
    const after = await json("/api/v1/notifications/requests", {
      headers: await auth(recipientEmail),
    });
    expect(read(z.array(RequestSchema), after.body)).toHaveLength(0);
  });

  it("pages notification requests with limit", async () => {
    const recipientEmail = "policy-limit-recipient@example.com";
    const recipient = await credentials(recipientEmail);
    const senders = ["a", "b", "c"];

    for (const sender of senders) {
      const email = `policy-limit-${sender}@example.com`;
      const account = await credentials(email);
      await json(`/api/v1/admin/accounts/${account.id}/silence`, {
        method: "POST",
        headers: await auth(`policy-limit-admin-${sender}@example.com`, true),
      });
      await postStatus(email, { status: `@${recipient.username} held ${sender}` });
    }

    const list = async (query = ""): Promise<z.infer<typeof RequestSchema>[]> => {
      const response = await json(`/api/v1/notifications/requests${query}`, {
        headers: await auth(recipientEmail),
      });
      expect(response.status).toBe(200);
      return read(z.array(RequestSchema), response.body);
    };

    const all = await list();
    expect(all).toHaveLength(3);
    // The newest request first, and `limit` takes a page off the top.
    expect(await list("?limit=1")).toEqual([all[0]]);
    expect(await list("?limit=2")).toEqual(all.slice(0, 2));
    // The documented cap is 80, so a larger request is clamped rather than
    // rejected.
    expect(await list("?limit=200")).toHaveLength(3);
  });

  it("includes held notifications with include_filtered", async () => {
    const recipientEmail = "policy-include-recipient@example.com";
    const senderEmail = "policy-include-sender@example.com";
    const recipient = await credentials(recipientEmail);
    const sender = await credentials(senderEmail);

    // Silence the sender so the default policy holds their mention back.
    await json(`/api/v1/admin/accounts/${sender.id}/silence`, {
      method: "POST",
      headers: await auth("policy-include-admin@example.com", true),
    });
    await postStatus(senderEmail, { status: `@${recipient.username} held from the list` });

    // The default list leaves it out; `include_filtered=true` puts it back.
    expect(await notifications(recipientEmail)).toHaveLength(0);
    const included = await json("/api/v1/notifications?include_filtered=true", {
      headers: await auth(recipientEmail),
    });
    expect(included.status).toBe(200);
    const listed = read(
      z.array(z.object({ type: z.string(), status: z.object({ id: z.string() }).nullable() })),
      included.body,
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]?.type).toBe("mention");

    // The grouped endpoint takes the same flag.
    const grouped = await json("/api/v2/notifications?include_filtered=true", {
      headers: await auth(recipientEmail),
    });
    expect(grouped.status).toBe(200);
    const envelope = read(
      z.object({
        notification_groups: z.array(
          z.object({ type: z.string(), notifications_count: z.number() }),
        ),
      }),
      grouped.body,
    );
    expect(envelope.notification_groups).toHaveLength(1);
    expect(envelope.notification_groups[0]?.notifications_count).toBe(1);

    // Without the flag the grouped list is empty, exactly like the v1 list.
    const withoutFlag = await json("/api/v2/notifications", {
      headers: await auth(recipientEmail),
    });
    expect(
      read(z.object({ notification_groups: z.array(z.unknown()) }), withoutFlag.body)
        .notification_groups,
    ).toHaveLength(0);
  });

  it("pages the request list by its own ids", async () => {
    const recipientEmail = "policy-page-recipient@example.com";
    const recipient = await credentials(recipientEmail);

    const senders: Array<{ id: string; email: string }> = [];
    for (const name of ["page-a", "page-b"]) {
      const email = `policy-${name}@example.com`;
      const sender = await credentials(email);
      senders.push({ id: sender.id, email });
      await json(`/api/v1/admin/accounts/${sender.id}/silence`, {
        method: "POST",
        headers: await auth(`policy-page-admin-${name}@example.com`, true),
      });
      await postStatus(email, { status: `@${recipient.username} held ${name}` });
    }

    const all = await json("/api/v1/notifications/requests", {
      headers: await auth(recipientEmail),
    });
    const requests = read(z.array(RequestSchema), all.body);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.id)).not.toEqual(senders.map((sender) => sender.id));

    // Newest first, and `max_id` pages older requests by the request id.
    const first = await json("/api/v1/notifications/requests?limit=1", {
      headers: await auth(recipientEmail),
    });
    const firstPage = read(z.array(RequestSchema), first.body);
    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]?.id).toBe(requests[0]?.id);
    const older = await json(
      `/api/v1/notifications/requests?limit=1&max_id=${firstPage[0]?.id ?? ""}`,
      { headers: await auth(recipientEmail) },
    );
    const olderPage = read(z.array(RequestSchema), older.body);
    expect(olderPage).toHaveLength(1);
    expect(olderPage[0]?.id).toBe(requests[1]?.id);

    // A resolved request can still be addressed by the sender for compatibility.
    const dismissed = await json(`/api/v1/notifications/requests/${senders[0]?.id ?? ""}/dismiss`, {
      method: "POST",
      headers: await auth(recipientEmail),
    });
    expect(dismissed.status).toBe(200);
  });
});
