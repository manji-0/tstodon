#!/usr/bin/env node
/**
 * E2E: Bob@B Follows Alice@A → Alice Create Note → Bob receives remote Create.
 *
 * Note: workerd local runtime often cannot fetch() other loopback ports, so we
 * pre-seed remote_actors (for signature verification) and, if needed, drive the
 * Create delivery HTTP hop from the host while still asserting A selected Bob
 * as an outbox target via ExpandFollowers.
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
  sleep,
  waitOk,
} from "./lib.js";

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice-fc@e2e.example");
  const bobHeaders = await authHeaders("bob-fc@e2e.example");

  const alice = await getJson(`${A}/api/v1/accounts/verify_credentials`, {
    headers: aliceHeaders,
  });
  const bob = await getJson(`${B}/api/v1/accounts/verify_credentials`, {
    headers: bobHeaders,
  });
  if (alice.status !== 200 || bob.status !== 200) {
    return fail("provision users", { alice, bob });
  }
  const aliceUser = requireUsername(alice.body, "provision users");
  const bobUser = requireUsername(bob.body, "provision users");
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const aliceActor = `${A}/users/${aliceUser}`;
  const bobActor = `${B}/users/${bobUser}`;
  const bobKeyId = `${bobActor}#main-key`;
  const aliceKeyId = `${aliceActor}#main-key`;
  const aliceInbox = `${A}/inbox`;
  const bobInbox = `${B}/inbox`;

  const bobDoc = await getJson(bobActor, { headers: { Accept: "application/activity+json" } });
  const aliceDoc = await getJson(aliceActor, {
    headers: { Accept: "application/activity+json" },
  });
  if (bobDoc.status !== 200 || aliceDoc.status !== 200) {
    return fail("actor documents", { bobDoc, aliceDoc });
  }
  seedRemoteActor("a", asActorDocument(bobDoc.body, "bob actor document"));
  seedRemoteActor("b", asActorDocument(aliceDoc.body, "alice actor document"));
  console.log("ok seeded remote_actors (loopback fetch workaround)");

  const bobKey = accountPrivateKeyJwk("b", bobUser);
  const followId = `${B}/activities/follow-${bobUser}-${aliceUser}-${Date.now()}`;
  const follow = await postSignedInbox(aliceInbox, bobKey, bobKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: followId,
    type: "Follow",
    actor: bobActor,
    object: aliceActor,
  });
  if (follow.status !== 202) {
    return fail("bob Follow → alice inbox", follow);
  }
  console.log("ok Follow accepted by A");

  let foundFollower = false;
  for (let i = 0; i < 20; i += 1) {
    const rows = d1Json(
      "a",
      `SELECT remote_actor_uri, follow_kind FROM remote_follows WHERE target_account_id = (SELECT id FROM accounts WHERE username = '${aliceUser}')`,
    );
    if (rows.some((row) => row.remote_actor_uri === bobActor && row.follow_kind === "Accepted")) {
      foundFollower = true;
      break;
    }
    await sleep(500);
  }
  if (!foundFollower) {
    return fail("remote_follows missing Accepted bob→alice on A");
  }
  console.log("ok remote_follows Accepted on A");

  const statusText = `hello bob from alice e2e ${Date.now()}`;
  const created = await getJson(`${A}/api/v1/statuses`, {
    method: "POST",
    headers: { ...aliceHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      status: statusText,
      visibility: "public",
    }),
  });
  if (created.status !== 200 || !isRecord(created.body) || created.body.id == null) {
    return fail("alice create status", created);
  }
  const createdId = created.body.id;
  console.log(`ok alice created status ${asString(createdId)}`);

  // Wait for ExpandFollowers to register Bob's inbox as a delivery target.
  let targetRow: Record<string, unknown> | undefined;
  for (let i = 0; i < 30; i += 1) {
    const rows = d1Json(
      "a",
      `SELECT activity_id, inbox_url, kind FROM outbox_deliveries WHERE inbox_url LIKE '%8792%' ORDER BY created_at DESC LIMIT 10`,
    );
    targetRow = rows.find((row) => String(row.inbox_url).includes("8792"));
    if (targetRow) {
      break;
    }
    await sleep(1000);
  }
  if (!targetRow) {
    return fail("ExpandFollowers did not create outbox target for B", {
      deliveries: d1Json(
        "a",
        "SELECT activity_id, inbox_url, kind FROM outbox_deliveries ORDER BY created_at DESC LIMIT 10",
      ),
    });
  }
  const outboxTarget = targetRow;
  console.log("ok outbox target for B", outboxTarget.inbox_url);

  // Prefer worker-delivered Create; fall back to host hop if loopback fetch fails.
  let remoteNote: Record<string, unknown> | undefined;
  let deliveryMode = "worker";
  for (let i = 0; i < 25; i += 1) {
    const rows = d1Json(
      "b",
      `SELECT id, object_uri, actor_uri, content_html FROM remote_statuses WHERE actor_uri = '${aliceActor}' ORDER BY published_at DESC LIMIT 5`,
    );
    remoteNote = rows.find((row) =>
      asString(row.content_html ?? "").includes("hello bob from alice e2e"),
    );
    if (remoteNote) {
      break;
    }
    await sleep(1000);
  }
  if (!remoteNote) {
    deliveryMode = "host";
    const activities = d1Json(
      "a",
      `SELECT id, payload_json FROM outbound_activities WHERE id = '${asString(outboxTarget.activity_id).replaceAll("'", "''")}' LIMIT 1`,
    );
    const payload = activities[0]?.payload_json;
    if (typeof payload !== "string") {
      return fail("outbound activity payload missing", activities);
    }
    const aliceKey = accountPrivateKeyJwk("a", aliceUser);
    const createActivity = JSON.parse(payload) as Record<string, unknown>;
    createActivity.id = `${String(createActivity.id)}-e2e-host-${Date.now()}`;
    const delivered = await postSignedInbox(bobInbox, aliceKey, aliceKeyId, createActivity);
    if (delivered.status !== 202 && delivered.status !== 200) {
      return fail("host-driven Create → bob inbox", delivered);
    }
    for (let i = 0; i < 20; i += 1) {
      const rows = d1Json(
        "b",
        `SELECT id, object_uri, actor_uri, content_html FROM remote_statuses WHERE actor_uri = '${aliceActor}' ORDER BY published_at DESC LIMIT 5`,
      );
      remoteNote = rows.find((row) =>
        asString(row.content_html ?? "").includes("hello bob from alice e2e"),
      );
      if (remoteNote) {
        break;
      }
      await sleep(500);
    }
  }
  if (!remoteNote) {
    return fail("remote Create not persisted on B", {
      inbox: d1Json(
        "b",
        "SELECT activity_id, kind FROM inbox_activities ORDER BY rowid DESC LIMIT 10",
      ),
    });
  }
  console.log(`ok remote Create Note on B (${deliveryMode}-delivered)`, remoteNote.object_uri);
  console.log("PASS federation follow→create");
};

main().catch((error: unknown) => fail("unhandled", error));
