#!/usr/bin/env node
/**
 * E2E: Alice@A reports Bob@B and one of his posts with `forward=true`. A sends
 * the report to B as a `Flag` from its instance actor; Mod, an admin on B,
 * gets the `admin.report` notification and finds the report on B's admin
 * reports page, filed by A's instance actor, with Bob's post attached.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { A, A_DOMAIN, B, api, d1Json, fail, signUp, waitFor, waitOk } from "./lib.js";
import { ApiStatus } from "./schemas.js";

const ResolvedAccounts = schemaResult(
  z.object({ accounts: z.array(z.object({ id: z.string(), uri: z.string() }).passthrough()) }),
);
const FiledReport = schemaResult(
  z
    .object({ id: z.string(), forwarded: z.boolean(), status_ids: z.array(z.string()) })
    .passthrough(),
);
const ReportNotifications = schemaResult(
  z.array(
    z
      .object({
        type: z.string(),
        account: z.object({ uri: z.string() }).passthrough(),
        report: z
          .object({
            comment: z.string(),
            target_account: z.object({ id: z.string() }).passthrough(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  ),
);

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice");
  const bob = await signUp(B, "bob");
  const mod = await signUp(B, "mod");
  d1Json(
    "b",
    `UPDATE "user" SET role = 'admin' WHERE id = (SELECT auth_user_id FROM accounts WHERE id = '${mod.id}')`,
  );
  console.log(`ok users ${alice.acct}, ${bob.acct}, admin ${mod.acct}`);

  const post = await api(B, bob.headers, "/api/v1/statuses", ApiStatus.parse, "bob posts", {
    method: "POST",
    body: { status: `reportable ${Date.now()}`, visibility: "public" },
  });
  const query = new URLSearchParams({ q: bob.acct, resolve: "true", type: "accounts" });
  const found = await api(
    A,
    alice.headers,
    `/api/v2/search?${query.toString()}`,
    ResolvedAccounts,
    `resolve ${bob.acct}`,
  );
  const bobOnA = found.accounts.find((account) => account.uri === bob.uri);
  if (!bobOnA) {
    return fail(`search did not resolve ${bob.acct}`, found);
  }
  const postOnA = await waitFor("A backfills bob's post from his outbox", async () => {
    const statuses = await api(
      A,
      alice.headers,
      `/api/v1/accounts/${bobOnA.id}/statuses`,
      ApiStatus.parseMany,
      "bob's statuses on A",
    );
    return statuses.find((status) => status.uri === post.uri);
  });
  console.log("ok alice sees bob and his post on A");

  const comment = `spam from bob ${Date.now()}`;
  const report = await api(A, alice.headers, "/api/v1/reports", FiledReport, "alice reports bob", {
    method: "POST",
    body: { account_id: bobOnA.id, status_ids: [postOnA.id], comment, forward: true },
  });
  if (!report.forwarded || report.status_ids[0] !== postOnA.id) {
    return fail("the report was not forwarded with bob's post", report);
  }
  console.log("ok alice files a forwarded report on A");

  const instanceActor = `${A}/actor`;
  const notified = await waitFor("B's admin is notified of the forwarded report", async () => {
    const notifications = await api(
      B,
      mod.headers,
      "/api/v1/notifications?types[]=admin.report",
      ReportNotifications,
      "mod's notifications",
    );
    return notifications.find((entry) => entry.report?.comment === comment);
  });
  if (notified.account.uri !== instanceActor || notified.report?.target_account.id !== bob.id) {
    return fail("the notification does not name A's instance actor and bob", notified);
  }
  console.log("ok admin.report notification on B from A's instance actor");

  const page = await (await mod.browser("/admin/reports")).text();
  if (!page.includes(comment) || !page.includes(`@${bob.username}`)) {
    return fail("B's admin reports page does not list the report", page);
  }
  const [stored] = d1Json(
    "b",
    `SELECT reporter_actor_uri, status_ids_json FROM reports WHERE comment = '${comment}'`,
  );
  const row = schemaResult(
    z.object({ reporter_actor_uri: z.string(), status_ids_json: z.string() }),
  )(stored);
  if (row.isErr() || row.value.reporter_actor_uri !== instanceActor) {
    return fail(`the report on B is not filed by ${A_DOMAIN}'s instance actor`, stored);
  }
  if (!row.value.status_ids_json.includes(post.id)) {
    return fail("the report on B does not carry bob's post", stored);
  }
  console.log("ok B's admin sees the report with bob's post on /admin/reports");
  console.log("PASS federation reports");
};

main().catch((error: unknown) => fail("unhandled", error));
