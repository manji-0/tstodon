#!/usr/bin/env node
/**
 * E2E: shared-inbox fan-out and a remote Delete. Bob@B follows Alice@A
 * through B's client API. A delivers Alice's post to B's shared inbox, which
 * B's actor document publishes, and Bob's home shows it. Alice deletes the
 * post; B drops it.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import {
  A,
  B,
  api,
  fail,
  fetchApPerson,
  followRemote,
  getJson,
  signUp,
  waitFor,
  waitOk,
  waitRows,
} from "./lib.js";
import { ApiStatus, OutboxDeliveryRow } from "./schemas.js";

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice-ds");
  const bob = await signUp(B, "bob-ds");
  console.log(`ok users ${alice.acct}, ${bob.acct}`);

  const bobDoc = await fetchApPerson(bob.uri, "bob actor document");
  const bobSharedInbox = bobDoc.endpoints?.sharedInbox;
  if (!bobSharedInbox || bobSharedInbox === bobDoc.inbox) {
    return fail("bob's actor document publishes no shared inbox apart from his own", bobDoc);
  }

  await followRemote(bob, alice);
  console.log("ok bob follows alice");

  const posted = await api(A, alice.headers, "/api/v1/statuses", ApiStatus.parse, "alice posts", {
    method: "POST",
    body: { status: `shared-inbox delete e2e ${Date.now()}`, visibility: "public" },
  });
  console.log(`ok created ${posted.id}`);

  const quoted = posted.uri.replaceAll("'", "''");
  await waitRows(
    "a",
    `SELECT d.inbox_url FROM outbox_deliveries d
       JOIN outbound_activities o ON o.id = d.activity_id
      WHERE o.kind = 'Create' AND json_extract(o.payload_json, '$.object.id') = '${quoted}'
        AND d.inbox_url IS NOT NULL`,
    OutboxDeliveryRow.parseMany,
    (rows) => rows.some((row) => row.inbox_url === bobSharedInbox),
    "A did not deliver alice's Create to B's shared inbox",
    40,
  );
  console.log("ok shared-inbox fan-out target", bobSharedInbox);

  const onB = await waitFor("alice's post on bob's home", async () => {
    const home = await api(B, bob.headers, "/api/v1/timelines/home", ApiStatus.parseMany, "home");
    return home.find((status) => status.uri === posted.uri);
  });
  console.log("ok Create on B via shared inbox", onB.id);

  await api(
    A,
    alice.headers,
    `/api/v1/statuses/${posted.id}`,
    schemaResult(z.unknown()),
    "delete",
    {
      method: "DELETE",
    },
  );
  await waitFor("B drops alice's deleted post", async () => {
    const read = await getJson(`${B}/api/v1/statuses/${onB.id}`, { headers: bob.headers });
    return read.status === 404 ? true : undefined;
  });
  const home = await api(B, bob.headers, "/api/v1/timelines/home", ApiStatus.parseMany, "home");
  if (home.some((status) => status.uri === posted.uri)) {
    return fail("alice's deleted post is still on bob's home", home);
  }
  console.log("ok Delete removed alice's post on B");
  console.log("PASS federation delete + shared-inbox");
};

main().catch((error: unknown) => fail("unhandled", error));
