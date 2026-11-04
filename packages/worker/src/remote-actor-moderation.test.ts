import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { schemaResult } from "@tstodon/core";
import { authHeaders, signedInAccount } from "../test/auth-fixture";
import { type Browser, ORIGIN, postForm, signUp } from "../test/passkey-browser";
import { remoteActor, type Remote } from "../test/remote-actor-fixture";
import { notificationDisposition } from "./notification-policy";
import { RemoteAccountId } from "./remote-account-id";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

const call = (path: string, init?: RequestInit) => SELF.fetch(`${ORIGIN}${path}`, init);

const read = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schemaResult(schema)(body);
  expect(parsed.isOk()).toBe(true);
  if (parsed.isErr()) {
    throw new Error("response schema rejected");
  }
  return parsed.value;
};

const ADMIN = "remote-moderation-admin@example.com";

const admin = async (path: string, body?: unknown) =>
  call(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(await authHeaders(ADMIN, { admin: true })),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const AdminAccountSchema = z.object({
  id: z.string(),
  acct: z.string(),
  domain: z.string(),
  silenced: z.boolean(),
  suspended: z.boolean(),
  limited: z.boolean(),
  sensitized: z.boolean(),
  disabled: z.boolean(),
  email: z.null(),
});

const adminAccount = async (id: string) => {
  const response = await admin(`/api/v1/admin/accounts/${id}`);
  expect(response.status).toBe(200);
  return read(AdminAccountSchema, await response.json());
};

const takeAction = (id: string, body: Record<string, unknown>) =>
  admin(`/api/v1/admin/accounts/${id}/action`, body);

/** A public note by `author`; its stored id and object URI. */
const publicNote = async (author: Remote, slug: string, extra: Record<string, unknown> = {}) => {
  const domain = new URL(author.actorUri).host;
  const object = {
    id: `https://${domain}/notes/${slug}`,
    type: "Note",
    attributedTo: author.actorUri,
    content: `<p>${slug}</p>`,
    published: "2026-10-20T00:00:00.000Z",
    to: [PUBLIC],
    ...extra,
  };
  expect(
    await author.send({
      id: `https://${domain}/activities/create-${slug}`,
      type: "Create",
      object,
    }),
  ).toBe(202);
  const row = await env.DB.prepare("SELECT id FROM remote_statuses WHERE object_uri = ?")
    .bind(object.id)
    .first<{ id: string }>();
  if (!row) {
    throw new Error("remote note was not stored");
  }
  return { id: row.id, uri: object.id };
};

const publicTimelineUris = async (): Promise<string[]> => {
  const response = await call("/api/v1/timelines/public?remote=true&limit=40");
  expect(response.status).toBe(200);
  return read(z.array(z.object({ uri: z.string() })), await response.json()).map(
    (status) => status.uri,
  );
};

describe("moderating a single remote account through the admin API", () => {
  it("lists cached remote actors with the state an admin gave them", async () => {
    const actor = await remoteActor("listed", "moderation-list.example");
    const other = await remoteActor("unlisted", "moderation-other.example");
    const id = RemoteAccountId.encode(actor.actorUri);

    const found = await admin(
      "/api/v1/admin/accounts?origin=remote&by_domain=moderation-list.example",
    );
    expect(found.status).toBe(200);
    expect(read(z.array(AdminAccountSchema), await found.json())).toMatchObject([
      {
        id,
        acct: "listed@moderation-list.example",
        domain: "moderation-list.example",
        silenced: false,
      },
    ]);

    expect((await takeAction(id, { type: "silence" })).status).toBe(200);
    const silenced = await admin("/api/v1/admin/accounts?origin=remote&silenced=true");
    expect(read(z.array(AdminAccountSchema), await silenced.json()).map((a) => a.id)).toEqual([id]);
    const suspended = await admin("/api/v1/admin/accounts?origin=remote&suspended=true");
    expect(read(z.array(AdminAccountSchema), await suspended.json())).toEqual([]);
    const local = await admin("/api/v1/admin/accounts");
    expect(
      read(z.array(z.object({ id: z.string() })), await local.json()).map((a) => a.id),
    ).not.toContain(id);
    expect(other.actorUri).not.toBe(actor.actorUri);
  });

  it("silences, suspends, and marks sensitive, and lifts each", async () => {
    const actor = await remoteActor("actioned", "moderation-action.example");
    const id = RemoteAccountId.encode(actor.actorUri);

    expect(await adminAccount(id)).toMatchObject({
      silenced: false,
      suspended: false,
      limited: false,
    });
    expect((await takeAction(id, { type: "silence" })).status).toBe(200);
    expect(await adminAccount(id)).toMatchObject({ silenced: true, limited: true });
    expect((await takeAction(id, { type: "sensitive" })).status).toBe(200);
    expect(await adminAccount(id)).toMatchObject({ silenced: true, sensitized: true });
    expect((await takeAction(id, { type: "suspend" })).status).toBe(200);
    expect(await adminAccount(id)).toMatchObject({ suspended: true, silenced: false });

    expect((await admin(`/api/v1/admin/accounts/${id}/unsuspend`, {})).status).toBe(200);
    expect((await admin(`/api/v1/admin/accounts/${id}/unsensitize`, {})).status).toBe(200);
    expect(await adminAccount(id)).toMatchObject({
      silenced: false,
      suspended: false,
      sensitized: false,
    });
    expect((await admin(`/api/v1/admin/accounts/${id}/silence`, {})).status).toBe(200);
    expect(await adminAccount(id)).toMatchObject({ silenced: true });
  });

  it("refuses what a remote account cannot take, and unknown actors", async () => {
    const actor = await remoteActor("limited-actions", "moderation-refused.example");
    const id = RemoteAccountId.encode(actor.actorUri);
    expect((await takeAction(id, { type: "disable" })).status).toBe(422);
    expect((await admin(`/api/v1/admin/accounts/${id}/enable`, {})).status).toBe(404);
    expect((await admin(`/api/v1/admin/accounts/${id}/approve`, {})).status).toBe(404);
    const unknown = RemoteAccountId.encode("https://nowhere.example/users/ghost");
    expect((await takeAction(unknown, { type: "silence" })).status).toBe(404);
    expect((await admin(`/api/v1/admin/accounts/${unknown}`)).status).toBe(404);
  });
});

describe("what moderating a remote account changes here", () => {
  it("keeps a limited actor's posts off the public timeline until the limit is lifted", async () => {
    const actor = await remoteActor("limited-poster", "moderation-timeline.example");
    const note = await publicNote(actor, "limited-1");
    const id = RemoteAccountId.encode(actor.actorUri);
    expect(await publicTimelineUris()).toContain(note.uri);

    await takeAction(id, { type: "silence" });
    expect(await publicTimelineUris()).not.toContain(note.uri);
    await admin(`/api/v1/admin/accounts/${id}/unsilence`, {});
    expect(await publicTimelineUris()).toContain(note.uri);
  });

  it("refuses everything a suspended actor sends, except deleting its own account", async () => {
    const actor = await remoteActor("suspended-sender", "moderation-suspend.example");
    const id = RemoteAccountId.encode(actor.actorUri);
    const first = await publicNote(actor, "before-suspension");
    await takeAction(id, { type: "suspend" });

    const refused = await actor.send({
      id: "https://moderation-suspend.example/activities/create-after",
      type: "Create",
      object: {
        id: "https://moderation-suspend.example/notes/after-suspension",
        type: "Note",
        attributedTo: actor.actorUri,
        content: "<p>after</p>",
        published: "2026-10-21T00:00:00.000Z",
        to: [PUBLIC],
      },
    });
    expect(refused).toBe(403);
    expect(await publicTimelineUris()).not.toContain(first.uri);

    await admin(`/api/v1/admin/accounts/${id}/unsuspend`, {});
    expect(await publicTimelineUris()).toContain(first.uri);
    await takeAction(id, { type: "suspend" });
    expect(
      await actor.send({
        id: "https://moderation-suspend.example/activities/delete-self",
        type: "Delete",
        object: actor.actorUri,
      }),
    ).toBe(202);
    expect((await admin(`/api/v1/admin/accounts/${id}`)).status).toBe(404);
  });

  it("marks a sensitive-flagged actor's media sensitive", async () => {
    const actor = await remoteActor("sensitive-poster", "moderation-media.example");
    const note = await publicNote(actor, "with-media", {
      attachment: [
        { type: "Document", mediaType: "image/png", url: "https://moderation-media.example/a.png" },
      ],
    });
    const plain = await publicNote(actor, "without-media");
    const id = RemoteAccountId.encode(actor.actorUri);
    const sensitiveOf = async (statusId: string) => {
      const response = await call(`/api/v1/statuses/${statusId}`);
      expect(response.status).toBe(200);
      return read(z.object({ sensitive: z.boolean() }), await response.json()).sensitive;
    };
    expect(await sensitiveOf(note.id)).toBe(false);

    await takeAction(id, { type: "sensitive" });
    expect(await sensitiveOf(note.id)).toBe(true);
    expect(await sensitiveOf(plain.id)).toBe(false);
    await admin(`/api/v1/admin/accounts/${id}/unsensitize`, {});
    expect(await sensitiveOf(note.id)).toBe(false);
  });

  it("filters a limited actor's notifications and drops a suspended one's", async () => {
    const recipient = await signedInAccount("remote-moderation-recipient@example.com");
    const actor = await remoteActor("noisy", "moderation-notify.example");
    const id = RemoteAccountId.encode(actor.actorUri);
    const disposition = async () => {
      const result = await notificationDisposition(env.DB, {
        recipientId: recipient.id,
        senderId: id,
        kind: "mention",
      });
      return result.isOk() ? result.value : result.error.message;
    };

    expect(await disposition()).toBe("accept");
    await takeAction(id, { type: "silence" });
    expect(await disposition()).toBe("filter");
    await takeAction(id, { type: "suspend" });
    expect(await disposition()).toBe("drop");
    await admin(`/api/v1/admin/accounts/${id}/unsuspend`, {});
    expect(await disposition()).toBe("accept");
  });

  it("leaves a suspended actor out of search", async () => {
    const actor = await remoteActor("searchable-quarry", "moderation-search.example");
    const id = RemoteAccountId.encode(actor.actorUri);
    const found = async () => {
      const response = await call("/api/v2/search?q=searchable-quarry&type=accounts", {
        headers: await authHeaders("remote-moderation-recipient@example.com"),
      });
      expect(response.status).toBe(200);
      return read(
        z.object({ accounts: z.array(z.object({ id: z.string() })) }),
        await response.json(),
      ).accounts.map((account) => account.id);
    };
    expect(await found()).toContain(id);
    await takeAction(id, { type: "suspend" });
    expect(await found()).not.toContain(id);
  });
});

/** A signed-in browser whose Better Auth user has the admin role. */
const adminBrowser = async (username: string): Promise<Browser> => {
  const { fetcher } = await signUp(username);
  await env.DB.prepare(
    `UPDATE "user" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE username = ?)`,
  )
    .bind(username)
    .run();
  return fetcher;
};

describe("moderating a remote account on the admin pages", () => {
  it("offers the actions on the account's page and applies them", async () => {
    const actor = await remoteActor("paged", "moderation-page.example");
    const id = RemoteAccountId.encode(actor.actorUri);
    const browser = await adminBrowser("remote_pages_admin");
    const path = `/admin/accounts/${id}`;

    const html = await (await browser(path)).text();
    expect(html).toContain("paged@moderation-page.example");
    for (const label of ["Limit", "Suspend", "Mark media as sensitive"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("Disable login");

    const limited = await postForm(browser, path, { do: "silence" });
    expect(limited.status).toBe(303);
    expect(limited.headers.get("location")).toBe(`${path}?notice=updated`);
    expect(await adminAccount(id)).toMatchObject({ silenced: true });
    expect(await (await browser(path)).text()).toContain("Lift limit");

    const asked = await postForm(browser, path, { do: "suspend" });
    expect(asked.status).toBe(200);
    expect(await adminAccount(id)).toMatchObject({ suspended: false });
    const suspended = await postForm(browser, path, { do: "suspend", confirmed: "1" });
    expect(suspended.status).toBe(303);
    expect(await adminAccount(id)).toMatchObject({ suspended: true });
    expect((await postForm(browser, path, { do: "suspend", confirmed: "1" })).status).toBe(422);
  });

  it("acts on a reported remote account from the report, which resolves it", async () => {
    const actor = await remoteActor("reported-on-page", "moderation-report.example");
    const id = RemoteAccountId.encode(actor.actorUri);
    const filed = await call("/api/v1/reports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("remote-moderation-recipient@example.com")),
      },
      body: JSON.stringify({ account_id: id, comment: "bad actor" }),
    });
    const reportId = read(z.object({ id: z.string() }), await filed.json()).id;
    const browser = await adminBrowser("remote_report_admin");

    const html = await (await browser(`/admin/reports/${reportId}`)).text();
    expect(html).toContain("@reported-on-page@moderation-report.example");
    expect(html).toContain("Act on");
    expect(html).not.toContain("Disable login");

    const acted = await postForm(browser, `/admin/reports/${reportId}/action`, { type: "silence" });
    expect(acted.status).toBe(303);
    expect(await adminAccount(id)).toMatchObject({ silenced: true });
    const report = await admin(`/api/v1/admin/reports/${reportId}`);
    expect(read(z.object({ action_taken: z.boolean() }), await report.json()).action_taken).toBe(
      true,
    );
  });
});

describe("reports about a remote actor that was purged", () => {
  it("keeps who it was on the report", async () => {
    const actor = await remoteActor("purged-target", "moderation-purged.example");
    const id = RemoteAccountId.encode(actor.actorUri);
    const filed = await call("/api/v1/reports", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await authHeaders("remote-moderation-recipient@example.com")),
      },
      body: JSON.stringify({ account_id: id, comment: "will be purged" }),
    });
    const reportId = read(z.object({ id: z.string() }), await filed.json()).id;
    expect(
      await actor.send({
        id: "https://moderation-purged.example/activities/delete-self",
        type: "Delete",
        object: actor.actorUri,
      }),
    ).toBe(202);
    expect((await admin(`/api/v1/admin/accounts/${id}`)).status).toBe(404);

    const report = await admin(`/api/v1/admin/reports/${reportId}`);
    expect(report.status).toBe(200);
    expect(
      read(
        z.object({
          target_account: z.object({ id: z.string(), acct: z.string(), username: z.string() }),
        }),
        await report.json(),
      ).target_account,
    ).toMatchObject({
      id,
      acct: "purged-target@moderation-purged.example",
      username: "purged-target",
    });

    const browser = await adminBrowser("remote_purged_admin");
    const page = await (await browser(`/admin/reports/${reportId}`)).text();
    expect(page).toContain("@purged-target@moderation-purged.example");
    expect(page).toContain("no longer has the reported account");
    const account = await (await browser(`/admin/accounts/${id}`)).text();
    expect(account).toContain("purged-target@moderation-purged.example");
    expect(account).toContain("no longer known to this server");
  });
});
