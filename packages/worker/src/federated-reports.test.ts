import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders } from "../test/auth-fixture";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
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
