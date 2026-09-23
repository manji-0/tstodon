#!/usr/bin/env node
/**
 * E2E: shared-inbox fan-out selection + remote Delete of a cached Note.
 */
import {
  A,
  B,
  A_DOMAIN,
  B_DOMAIN,
  accountPrivateKeyJwk,
  authHeaders,
  d1Json,
  fail,
  getJson,
  postSignedInbox,
  seedRemoteActor,
  sleep,
  waitOk,
} from "./lib.mjs";

const waitRows = async (instance, sql, predicate, label, attempts = 40) => {
  for (let i = 0; i < attempts; i += 1) {
    const rows = d1Json(instance, sql);
    if (predicate(rows)) {
      return rows;
    }
    await sleep(500);
  }
  fail(label, d1Json(instance, sql));
};

const main = async () => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice-ds@e2e.example");
  const bobHeaders = await authHeaders("bob-ds@e2e.example");
  const alice = await getJson(`${A}/api/v1/accounts/verify_credentials`, {
    headers: aliceHeaders,
  });
  const bob = await getJson(`${B}/api/v1/accounts/verify_credentials`, {
    headers: bobHeaders,
  });
  if (alice.status !== 200 || bob.status !== 200) {
    fail("provision", { alice, bob });
  }
  const aliceUser = alice.body.username;
  const bobUser = bob.body.username;
  const aliceActor = `${A}/users/${aliceUser}`;
  const bobActor = `${B}/users/${bobUser}`;
  const bobKeyId = `${bobActor}#main-key`;
  const aliceKeyId = `${aliceActor}#main-key`;
  const aliceInbox = `${A}/inbox`;
  const bobSharedInbox = `${B}/inbox`;
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const bobDoc = await getJson(bobActor, { headers: { Accept: "application/activity+json" } });
  const aliceDoc = await getJson(aliceActor, {
    headers: { Accept: "application/activity+json" },
  });
  if (bobDoc.status !== 200 || aliceDoc.status !== 200) {
    fail("actor docs", { bobDoc, aliceDoc });
  }
  // Force shared-inbox preference for fan-out selection on A.
  seedRemoteActor("a", {
    ...bobDoc.body,
    endpoints: { sharedInbox: bobSharedInbox },
  });
  seedRemoteActor("b", aliceDoc.body);
  console.log("ok seeded remote_actors with sharedInbox on bob");

  const bobKey = accountPrivateKeyJwk("b", bobUser);
  const follow = await postSignedInbox(aliceInbox, bobKey, bobKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${B}/activities/follow-ds-${Date.now()}`,
    type: "Follow",
    actor: bobActor,
    object: aliceActor,
  });
  if (follow.status !== 202) {
    fail("Follow", follow);
  }
  await waitRows(
    "a",
    `SELECT follow_kind FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    (rows) => rows.some((r) => r.follow_kind === "Accepted"),
    "follow not Accepted",
  );

  const statusText = `shared-inbox delete e2e ${Date.now()}`;
  const created = await getJson(`${A}/api/v1/statuses`, {
    method: "POST",
    headers: { ...aliceHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ status: statusText, visibility: "public" }),
  });
  if (created.status !== 200 || !created.body?.id) {
    fail("create", created);
  }
  const statusId = created.body.id;
  const statusUri = `${aliceActor}/statuses/${statusId}`;
  console.log(`ok created ${statusId}`);

  const targets = await waitRows(
    "a",
    `SELECT inbox_url FROM outbox_deliveries WHERE inbox_url LIKE '%8792%' ORDER BY created_at DESC LIMIT 10`,
    (rows) => rows.some((r) => String(r.inbox_url) === bobSharedInbox),
    "ExpandFollowers did not select shared inbox",
  );
  console.log(
    "ok shared-inbox fan-out target",
    targets.find((r) => String(r.inbox_url) === bobSharedInbox)?.inbox_url,
  );

  const delivery = d1Json(
    "a",
    `SELECT activity_id, inbox_url FROM outbox_deliveries WHERE inbox_url = '${bobSharedInbox}' ORDER BY created_at DESC LIMIT 1`,
  )[0];
  const payloadRows = d1Json(
    "a",
    `SELECT payload_json FROM outbound_activities WHERE id = '${String(delivery.activity_id).replaceAll("'", "''")}' LIMIT 1`,
  );
  const createActivity = JSON.parse(payloadRows[0].payload_json);
  createActivity.id = `${createActivity.id}-host-${Date.now()}`;
  const aliceKey = accountPrivateKeyJwk("a", aliceUser);
  const delivered = await postSignedInbox(bobSharedInbox, aliceKey, aliceKeyId, createActivity);
  if (delivered.status !== 202 && delivered.status !== 200) {
    fail("Create to shared inbox", delivered);
  }
  await waitRows(
    "b",
    `SELECT object_uri, content_html FROM remote_statuses WHERE object_uri = '${statusUri}'`,
    (rows) => rows.length === 1,
    "Create not on B",
  );
  console.log("ok Create on B via shared inbox");

  const deleted = await postSignedInbox(bobSharedInbox, aliceKey, aliceKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${A}/activities/delete-${statusId}-${Date.now()}`,
    type: "Delete",
    actor: aliceActor,
    object: statusUri,
  });
  if (deleted.status !== 202 && deleted.status !== 200) {
    fail("Delete to B", deleted);
  }
  await waitRows(
    "b",
    `SELECT object_uri FROM remote_statuses WHERE object_uri = '${statusUri}'`,
    (rows) => rows.length === 0,
    "Delete did not remove remote_statuses",
  );
  console.log("ok Delete cleared remote_statuses on B");
  console.log("PASS federation delete + shared-inbox");
};

main().catch((error) => fail("unhandled", error));
