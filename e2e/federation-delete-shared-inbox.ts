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
  asActorDocument,
  authHeaders,
  d1Json,
  fail,
  getJson,
  asString,
  isRecord,
  postSignedInbox,
  requireUsername,
  seedRemoteActor,
  waitOk,
  waitRows,
  type D1Row,
} from "./lib.js";

const main = async (): Promise<void> => {
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
    return fail("provision", { alice, bob });
  }
  const aliceUser = requireUsername(alice.body, "provision");
  const bobUser = requireUsername(bob.body, "provision");
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
    return fail("actor docs", { bobDoc, aliceDoc });
  }
  // Force shared-inbox preference for fan-out selection on A.
  const bobActorDoc = asActorDocument(bobDoc.body, "bob actor document");
  seedRemoteActor("a", {
    ...bobActorDoc,
    endpoints: { sharedInbox: bobSharedInbox },
  });
  seedRemoteActor("b", asActorDocument(aliceDoc.body, "alice actor document"));
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
    return fail("Follow", follow);
  }
  await waitRows(
    "a",
    `SELECT follow_kind FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    (rows: D1Row[]) => rows.some((r) => r.follow_kind === "Accepted"),
    "follow not Accepted",
    40,
  );

  const statusText = `shared-inbox delete e2e ${Date.now()}`;
  const created = await getJson(`${A}/api/v1/statuses`, {
    method: "POST",
    headers: { ...aliceHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ status: statusText, visibility: "public" }),
  });
  if (created.status !== 200 || !isRecord(created.body) || created.body.id == null) {
    return fail("create", created);
  }
  const statusId = asString(created.body.id);
  const statusUri = `${aliceActor}/statuses/${statusId}`;
  console.log(`ok created ${statusId}`);

  const targets = await waitRows(
    "a",
    `SELECT inbox_url FROM outbox_deliveries WHERE inbox_url LIKE '%8792%' ORDER BY created_at DESC LIMIT 10`,
    (rows: D1Row[]) => rows.some((r) => String(r.inbox_url) === bobSharedInbox),
    "ExpandFollowers did not select shared inbox",
    40,
  );
  console.log(
    "ok shared-inbox fan-out target",
    targets.find((r) => String(r.inbox_url) === bobSharedInbox)?.inbox_url,
  );

  const delivery = d1Json(
    "a",
    `SELECT activity_id, inbox_url FROM outbox_deliveries WHERE inbox_url = '${bobSharedInbox}' ORDER BY created_at DESC LIMIT 1`,
  )[0];
  if (!delivery) {
    return fail("missing shared-inbox delivery row");
  }
  const payloadRows = d1Json(
    "a",
    `SELECT payload_json FROM outbound_activities WHERE id = '${asString(delivery.activity_id).replaceAll("'", "''")}' LIMIT 1`,
  );
  const payloadJson = payloadRows[0]?.payload_json;
  if (typeof payloadJson !== "string") {
    return fail("missing Create payload", payloadRows);
  }
  const createActivity = JSON.parse(payloadJson) as Record<string, unknown>;
  createActivity.id = `${String(createActivity.id)}-host-${Date.now()}`;
  const aliceKey = accountPrivateKeyJwk("a", aliceUser);
  const delivered = await postSignedInbox(bobSharedInbox, aliceKey, aliceKeyId, createActivity);
  if (delivered.status !== 202 && delivered.status !== 200) {
    return fail("Create to shared inbox", delivered);
  }
  await waitRows(
    "b",
    `SELECT object_uri, content_html FROM remote_statuses WHERE object_uri = '${statusUri}'`,
    (rows: D1Row[]) => rows.length === 1,
    "Create not on B",
    40,
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
    return fail("Delete to B", deleted);
  }
  await waitRows(
    "b",
    `SELECT object_uri FROM remote_statuses WHERE object_uri = '${statusUri}'`,
    (rows: D1Row[]) => rows.length === 0,
    "Delete did not remove remote_statuses",
    40,
  );
  console.log("ok Delete cleared remote_statuses on B");
  console.log("PASS federation delete + shared-inbox");
};

main().catch((error: unknown) => fail("unhandled", error));
