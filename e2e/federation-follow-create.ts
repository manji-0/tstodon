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
  asString,
  authHeaders,
  d1Rows,
  expectParsed,
  fail,
  fetchApPerson,
  fetchMastodonAccount,
  getJsonParsed,
  postSignedInbox,
  seedRemoteActor,
  sleep,
  waitOk,
} from "./lib.js";
import {
  ApWireActivity,
  MastodonStatus,
  OutboundActivityRow,
  OutboxDeliveryRow,
  RemoteFollowRow,
  RemoteStatusRow,
  InboxActivityRow,
} from "./schemas.js";

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice-fc@e2e.example");
  const bobHeaders = await authHeaders("bob-fc@e2e.example");

  const alice = await fetchMastodonAccount(A, aliceHeaders, "provision users");
  const bob = await fetchMastodonAccount(B, bobHeaders, "provision users");
  const aliceUser = alice.username;
  const bobUser = bob.username;
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const aliceActor = `${A}/users/${aliceUser}`;
  const bobActor = `${B}/users/${bobUser}`;
  const bobKeyId = `${bobActor}#main-key`;
  const aliceKeyId = `${aliceActor}#main-key`;
  const aliceInbox = `${A}/inbox`;
  const bobInbox = `${B}/inbox`;

  const bobDoc = await fetchApPerson(bobActor, "bob actor document");
  const aliceDoc = await fetchApPerson(aliceActor, "alice actor document");
  seedRemoteActor("a", bobDoc);
  seedRemoteActor("b", aliceDoc);
  console.log("ok seeded remote_actors (loopback fetch workaround)");

  const bobKey = accountPrivateKeyJwk("b", bobUser);
  const followId = `${B}/activities/follow-${bobUser}-${aliceUser}-${Date.now()}`;
  const followActivity = expectParsed("bob Follow activity", ApWireActivity.follow.parse, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: followId,
    type: "Follow",
    actor: bobActor,
    object: aliceActor,
  });
  const follow = await postSignedInbox(aliceInbox, bobKey, bobKeyId, followActivity);
  if (follow.status !== 202) {
    return fail("bob Follow → alice inbox", follow);
  }
  console.log("ok Follow accepted by A");

  let foundFollower = false;
  for (let i = 0; i < 20; i += 1) {
    const rows = d1Rows(
      "a",
      `SELECT remote_actor_uri, follow_kind FROM remote_follows WHERE target_account_id = (SELECT id FROM accounts WHERE username = '${aliceUser}')`,
      RemoteFollowRow.parseMany,
      "remote_follows poll",
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
  const created = await getJsonParsed(
    `${A}/api/v1/statuses`,
    MastodonStatus.parse,
    "alice create status",
    {
      method: "POST",
      headers: { ...aliceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        status: statusText,
        visibility: "public",
      }),
    },
  );
  if (created.status !== 200) {
    return fail("alice create status", created);
  }
  console.log(`ok alice created status ${created.body.id}`);

  let targetRow: OutboxDeliveryRow | undefined;
  for (let i = 0; i < 30; i += 1) {
    const rows = d1Rows(
      "a",
      `SELECT activity_id, inbox_url, kind FROM outbox_deliveries WHERE inbox_url LIKE '%8792%' ORDER BY created_at DESC LIMIT 10`,
      OutboxDeliveryRow.parseMany,
      "outbox_deliveries poll",
    );
    targetRow = rows.find((row) => row.inbox_url.includes("8792"));
    if (targetRow) {
      break;
    }
    await sleep(1000);
  }
  if (!targetRow) {
    return fail("ExpandFollowers did not create outbox target for B", {
      deliveries: d1Rows(
        "a",
        "SELECT activity_id, inbox_url, kind FROM outbox_deliveries ORDER BY created_at DESC LIMIT 10",
        OutboxDeliveryRow.parseMany,
        "outbox_deliveries dump",
      ),
    });
  }
  const outboxTarget = targetRow;
  console.log("ok outbox target for B", outboxTarget.inbox_url);

  let remoteNote: RemoteStatusRow | undefined;
  let deliveryMode = "worker";
  for (let i = 0; i < 25; i += 1) {
    const rows = d1Rows(
      "b",
      `SELECT id, object_uri, actor_uri, content_html FROM remote_statuses WHERE actor_uri = '${aliceActor}' ORDER BY published_at DESC LIMIT 5`,
      RemoteStatusRow.parseMany,
      "remote_statuses poll",
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
    const activities = d1Rows(
      "a",
      `SELECT id, payload_json FROM outbound_activities WHERE id = '${asString(outboxTarget.activity_id).replaceAll("'", "''")}' LIMIT 1`,
      OutboundActivityRow.parseMany,
      "outbound Create payload",
    );
    const activityRow = activities[0];
    if (!activityRow) {
      return fail("outbound activity payload missing", activities);
    }
    const createActivity = expectParsed(
      "outbound Create wire",
      ApWireActivity.create.parse,
      JSON.parse(activityRow.payload_json),
    );
    const hostCreate = {
      ...createActivity,
      id: `${createActivity.id}-e2e-host-${Date.now()}`,
    };
    const aliceKey = accountPrivateKeyJwk("a", aliceUser);
    const delivered = await postSignedInbox(bobInbox, aliceKey, aliceKeyId, hostCreate);
    if (delivered.status !== 202 && delivered.status !== 200) {
      return fail("host-driven Create → bob inbox", delivered);
    }
    for (let i = 0; i < 20; i += 1) {
      const rows = d1Rows(
        "b",
        `SELECT id, object_uri, actor_uri, content_html FROM remote_statuses WHERE actor_uri = '${aliceActor}' ORDER BY published_at DESC LIMIT 5`,
        RemoteStatusRow.parseMany,
        "remote_statuses host poll",
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
      inbox: d1Rows(
        "b",
        "SELECT activity_id, kind FROM inbox_activities ORDER BY rowid DESC LIMIT 10",
        InboxActivityRow.parseMany,
        "inbox_activities dump",
      ),
    });
  }
  console.log(`ok remote Create Note on B (${deliveryMode}-delivered)`, remoteNote.object_uri);
  console.log("PASS federation follow→create");
};

main().catch((error: unknown) => fail("unhandled", error));
