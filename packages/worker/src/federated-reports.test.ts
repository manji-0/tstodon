import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { OutboxJob } from "@tstodon/domain";
import { attemptInboxDelivery } from "./delivery";
import { RemoteAccountId } from "./remote-account-id";

const json = async (path: string, init?: RequestInit) => {
  const response = await SELF.fetch(`https://example.com${path}`, init);
  return { status: response.status, body: await response.json() };
};

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const AdminReportSchema = z.object({
  id: z.string(),
  comment: z.string(),
  category: z.string(),
  forwarded: z.boolean(),
  account: z.object({ id: z.string(), username: z.string() }).nullable(),
  target_account: z.object({ id: z.string(), username: z.string() }).nullable(),
  statuses: z.array(z.object({ id: z.string(), uri: z.string() })),
});

const adminReports = async (query: string) => {
  const response = await json(`/api/v1/admin/reports?${query}`, {
    headers: await authHeaders("reports-admin@example.com", { admin: true }),
  });
  expect(response.status).toBe(200);
  return read(z.array(AdminReportSchema), response.body);
};

/** A public note by `remote`, received and stored here; returns its API id. */
const remoteNote = async (remote: Remote, slug: string): Promise<string> => {
  const objectUri = `${remote.actorUri}/notes/${slug}`;
  expect(
    await remote.send({
      id: `${objectUri}/activity`,
      type: "Create",
      object: {
        id: objectUri,
        type: "Note",
        attributedTo: remote.actorUri,
        content: `<p>${slug}</p>`,
        published: "2026-10-20T00:00:00.000Z",
        to: ["https://www.w3.org/ns/activitystreams#Public"],
      },
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(objectUri)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("remote note was not stored");
  }
  return row.id;
};

const fileReport = async (email: string, body: Record<string, unknown>) =>
  json("/api/v1/reports", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify(body),
  });

describe("reports on remote accounts", () => {
  it("files a report on a remote account with its own posts only", async () => {
    const target = await remoteActor("reported-spammer");
    const bystander = await remoteActor("reported-bystander");
    const own = await remoteNote(target, "spam-1");
    const other = await remoteNote(bystander, "not-spam");
    const targetId = RemoteAccountId.encode(target.actorUri);
    const filed = await fileReport("remote-reporter@example.com", {
      account_id: targetId,
      status_ids: [own, other],
      comment: "spam from afar",
    });
    expect(filed.status).toBe(200);
    const report = read(
      z.object({ id: z.string(), status_ids: z.array(z.string()), forwarded: z.boolean() }),
      filed.body,
    );
    expect(report).toMatchObject({ status_ids: [own], forwarded: false });

    const [listed] = await adminReports(`target_account_id=${targetId}`);
    expect(listed).toMatchObject({
      id: report.id,
      comment: "spam from afar",
      forwarded: false,
      target_account: { id: targetId, username: "reported-spammer" },
      statuses: [{ id: own, uri: `${target.actorUri}/notes/spam-1` }],
    });
  });

  it("refuses a report on an account this server does not know", async () => {
    const filed = await fileReport("remote-reporter@example.com", {
      account_id: RemoteAccountId.encode("https://unknown.example/users/nobody"),
    });
    expect(filed.status).toBe(404);
  });
});

/** A local account with one public post; the actor and post URIs a `Flag` names. */
const localPoster = async (email: string, text: string) => {
  const account = await signedInAccount(email);
  const posted = await json("/api/v1/statuses", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await authHeaders(email)) },
    body: JSON.stringify({ status: text }),
  });
  expect(posted.status).toBe(200);
  const status = read(z.object({ id: z.string(), uri: z.string() }), posted.body);
  return {
    id: account.id,
    actorUri: `https://example.com/users/${account.username}`,
    status,
  };
};

const NotificationSchema = z.object({
  type: z.string(),
  account: z.object({ id: z.string() }),
  report: z.object({ id: z.string(), target_account: z.object({ id: z.string() }) }).optional(),
});

const adminNotifications = async () => {
  const response = await json("/api/v1/notifications?types[]=admin.report", {
    headers: await authHeaders("reports-admin@example.com", { admin: true }),
  });
  expect(response.status).toBe(200);
  return read(z.array(NotificationSchema), response.body);
};

describe("reports from other servers", () => {
  it("files a Flag as a report by the remote actor, once, and tells the admins", async () => {
    await adminNotifications();
    const target = await localPoster("flag-target@example.com", "reported post");
    const bystander = await localPoster("flag-bystander@example.com", "innocent post");
    const flagger = await remoteActor("flag-instance", "flagging.example");
    const flaggerId = RemoteAccountId.encode(flagger.actorUri);
    const flag = {
      id: "https://flagging.example/flags/1",
      type: "Flag",
      content: "Please look at this",
      object: [target.actorUri, target.status.uri, bystander.status.uri],
    };
    expect(await flagger.send(flag)).toBe(202);
    expect(await flagger.send(flag)).toBe(202);

    const reports = await adminReports(`account_id=${flaggerId}`);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      comment: "Please look at this",
      category: "other",
      account: { id: flaggerId, username: "flag-instance" },
      target_account: { id: target.id },
      statuses: [{ id: target.status.id }],
    });
    const notified = (await adminNotifications()).filter(
      (entry) => entry.report?.id === reports[0]?.id,
    );
    expect(notified).toMatchObject([
      {
        type: "admin.report",
        account: { id: flaggerId },
        report: { target_account: { id: target.id } },
      },
    ]);
  });

  it("reports the author when a Flag names only posts, and caps the comment", async () => {
    const target = await localPoster("flag-author@example.com", "only the post is named");
    const flagger = await remoteActor("flag-posts", "flagging-posts.example");
    expect(
      await flagger.send({
        id: "https://flagging-posts.example/flags/1",
        type: "Flag",
        content: "x".repeat(1500),
        object: target.status.uri,
      }),
    ).toBe(202);
    const [report] = await adminReports(`account_id=${RemoteAccountId.encode(flagger.actorUri)}`);
    expect(report?.target_account?.id).toBe(target.id);
    expect(report?.statuses.map((status) => status.id)).toEqual([target.status.id]);
    expect(report?.comment).toHaveLength(1000);
  });

  it("ignores a Flag from a server whose reports are rejected", async () => {
    const blocked = await json("/api/v1/admin/domain_blocks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("reports-admin@example.com", { admin: true })),
      },
      body: JSON.stringify({ domain: "noisy.example", severity: "noop", reject_reports: true }),
    });
    expect(blocked.status).toBe(200);
    const target = await localPoster("flag-ignored@example.com", "not reported");
    const flagger = await remoteActor("flag-noisy", "noisy.example");
    expect(
      await flagger.send({
        id: "https://noisy.example/flags/1",
        type: "Flag",
        content: "noise",
        object: [target.actorUri],
      }),
    ).toBe(202);
    expect(await adminReports(`account_id=${RemoteAccountId.encode(flagger.actorUri)}`)).toEqual(
      [],
    );
  });
});

const FlagSchema = z.object({
  id: z.string(),
  type: z.literal("Flag"),
  actor: z.string(),
  content: z.string(),
  object: z.array(z.string()),
});

/** The `Flag`s queued for `inbox`, with who signs each (`null`: the instance actor). */
const queuedFlags = async (inbox: string) => {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.account_id, a.payload_json FROM outbound_activities a
     JOIN outbox_deliveries d ON d.activity_id = a.id
     WHERE a.kind = 'Flag' AND d.inbox_url = ? ORDER BY a.rowid`,
  )
    .bind(inbox)
    .all<{ id: string; account_id: string | null; payload_json: string }>();
  return results.map((row) => ({
    activityId: row.id,
    signer: row.account_id,
    flag: read(FlagSchema, JSON.parse(row.payload_json)),
  }));
};

/** Deliver a queued activity, returning the signed request that went out. */
const deliver = async (activityId: string, inbox: string): Promise<Request> => {
  const job = OutboxJob.parse({ kind: "DeliverTarget", activityId, inboxUrl: inbox });
  if (job.isErr() || job.value.kind !== "DeliverTarget") {
    throw new Error("deliver job rejected");
  }
  const sent: Request[] = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    sent.push(new Request(input, init));
    return new Response(null, { status: 202 });
  });
  try {
    expect((await attemptInboxDelivery(env, job.value)).kind).toBe("Success");
  } finally {
    fetchSpy.mockRestore();
  }
  const [request] = sent;
  if (!request) {
    throw new Error("nothing was delivered");
  }
  return request;
};

describe("forwarding reports", () => {
  it("forwards a report on a remote account as a Flag from the instance actor", async () => {
    const target = await remoteActor("forward-target", "forward.example");
    const post = await remoteNote(target, "forward-1");
    const targetId = RemoteAccountId.encode(target.actorUri);
    const filed = await fileReport("forward-reporter@example.com", {
      account_id: targetId,
      status_ids: [post],
      comment: "forward this",
      forward: true,
    });
    expect(filed.status).toBe(200);
    const report = read(z.object({ id: z.string(), forwarded: z.boolean() }), filed.body);
    expect(report.forwarded).toBe(true);

    const inbox = `${target.actorUri}/inbox`;
    const queued = await queuedFlags(inbox);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      signer: null,
      flag: {
        actor: "https://example.com/actor",
        content: "forward this",
        object: [target.actorUri, `${target.actorUri}/notes/forward-1`],
      },
    });
    const request = await deliver(queued[0]?.activityId ?? "", inbox);
    expect(request.headers.get("Signature")).toContain(
      'keyId="https://example.com/actor#main-key"',
    );
    expect(await request.text()).not.toContain("forward-reporter");

    const [listed] = await adminReports(`target_account_id=${targetId}`);
    expect(listed).toMatchObject({ id: report.id, forwarded: true });
  });

  it("keeps a report here without forward, and for a local account", async () => {
    const target = await remoteActor("unforwarded-target", "unforwarded.example");
    const kept = await fileReport("forward-reporter@example.com", {
      account_id: RemoteAccountId.encode(target.actorUri),
      comment: "only for this server",
    });
    expect(read(z.object({ forwarded: z.boolean() }), kept.body).forwarded).toBe(false);
    expect(await queuedFlags(`${target.actorUri}/inbox`)).toEqual([]);

    const local = await signedInAccount("forward-local-target@example.com");
    const localReport = await fileReport("forward-reporter@example.com", {
      account_id: local.id,
      forward: true,
    });
    expect(read(z.object({ forwarded: z.boolean() }), localReport.body).forwarded).toBe(false);
    const flags = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM outbound_activities WHERE kind = 'Flag' AND payload_json LIKE ?",
    )
      .bind(`%/users/${local.username}%`)
      .first<{ n: number }>();
    expect(flags?.n).toBe(0);
  });
});
