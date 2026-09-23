#!/usr/bin/env node
/**
 * E2E: Bob@B Follows Alice@A → Alice enqueues Accept → Accept recorded for Bob.
 *
 * workerd may not deliver Accept over loopback; we assert A's outbound Accept
 * + outbox target, then host-drive Accept into B's inbox if needed.
 */
import {
  A,
  B,
  A_DOMAIN,
  B_DOMAIN,
  accountPrivateKeyJwk,
  authHeaders,
  d1Rows,
  expectParsed,
  fail,
  fetchApPerson,
  fetchMastodonAccount,
  postSignedInbox,
  seedRemoteActor,
  waitOk,
  waitRows,
} from "./lib.js";
import {
  ApWireActivity,
  acceptObjectId,
  InboxActivityRow,
  OutboundActivityRow,
  OutboxDeliveryRow,
  RemoteFollowRow,
} from "./schemas.js";

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice-ac@e2e.example");
  const bobHeaders = await authHeaders("bob-ac@e2e.example");
  const alice = await fetchMastodonAccount(A, aliceHeaders, "provision");
  const bob = await fetchMastodonAccount(B, bobHeaders, "provision");
  const aliceUser = alice.username;
  const bobUser = bob.username;
  const aliceActor = `${A}/users/${aliceUser}`;
  const bobActor = `${B}/users/${bobUser}`;
  const bobKeyId = `${bobActor}#main-key`;
  const aliceInbox = `${A}/inbox`;
  const bobInbox = `${B}/inbox`;
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const bobDoc = await fetchApPerson(bobActor, "bob actor document");
  const aliceDoc = await fetchApPerson(aliceActor, "alice actor document");
  seedRemoteActor("a", bobDoc);
  seedRemoteActor("b", aliceDoc);

  const bobKey = accountPrivateKeyJwk("b", bobUser);
  const followId = `${B}/activities/follow-ac-${Date.now()}`;
  const followActivity = expectParsed("Follow activity", ApWireActivity.follow.parse, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: followId,
    type: "Follow",
    actor: bobActor,
    object: aliceActor,
  });
  const follow = await postSignedInbox(aliceInbox, bobKey, bobKeyId, followActivity);
  if (follow.status !== 202) {
    return fail("Follow", follow);
  }
  await waitRows(
    "a",
    `SELECT follow_kind FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    RemoteFollowRow.parseMany,
    (rows) => rows.some((r) => r.follow_kind === "Accepted"),
    "follow not Accepted",
    40,
  );
  console.log("ok Follow Accepted in DB");

  const acceptRows = await waitRows(
    "a",
    `SELECT id, kind, payload_json FROM outbound_activities WHERE kind = 'Accept' ORDER BY created_at DESC LIMIT 5`,
    OutboundActivityRow.parseMany,
    (rows) =>
      rows.some((r) => {
        const wire = ApWireActivity.accept.parse(JSON.parse(r.payload_json));
        return wire.isOk() && acceptObjectId(wire.value) === followId;
      }),
    "Accept outbound activity missing on A",
    40,
  );
  const acceptActivityRow = acceptRows.find((r) => {
    const wire = ApWireActivity.accept.parse(JSON.parse(r.payload_json));
    return wire.isOk() && acceptObjectId(wire.value) === followId;
  });
  if (!acceptActivityRow) {
    return fail("Accept outbound activity missing on A", acceptRows);
  }
  console.log("ok Accept outbound on A", acceptActivityRow.id);

  await waitRows(
    "a",
    `SELECT inbox_url FROM outbox_deliveries WHERE activity_id = '${acceptActivityRow.id}'`,
    OutboxDeliveryRow.parseMany,
    (rows) => rows.some((r) => r.inbox_url.includes("8792")),
    "Accept missing outbox target to B",
    40,
  );
  console.log("ok Accept targeted to B");

  const acceptOnB = d1Rows(
    "b",
    `SELECT activity_id, kind, payload_json FROM inbox_activities WHERE kind = 'Accept' ORDER BY rowid DESC LIMIT 10`,
    InboxActivityRow.parseMany,
    "inbox Accept poll",
  ).some((r) => {
    if (typeof r.payload_json !== "string") {
      return false;
    }
    const wire = ApWireActivity.accept.parse(JSON.parse(r.payload_json));
    return wire.isOk() && acceptObjectId(wire.value) === followId;
  });
  if (!acceptOnB) {
    const aliceKey = accountPrivateKeyJwk("a", aliceUser);
    const payload = expectParsed(
      "Accept wire payload",
      ApWireActivity.accept.parse,
      JSON.parse(acceptActivityRow.payload_json),
    );
    const hostAccept = { ...payload, id: `${payload.id}-host-${Date.now()}` };
    const delivered = await postSignedInbox(
      bobInbox,
      aliceKey,
      `${aliceActor}#main-key`,
      hostAccept,
    );
    if (delivered.status !== 202 && delivered.status !== 200) {
      return fail("host-driven Accept", delivered);
    }
    await waitRows(
      "b",
      `SELECT payload_json FROM inbox_activities WHERE kind = 'Accept' ORDER BY rowid DESC LIMIT 10`,
      InboxActivityRow.parseMany,
      (rows) =>
        rows.some((r) => {
          if (typeof r.payload_json !== "string") {
            return false;
          }
          const wire = ApWireActivity.accept.parse(JSON.parse(r.payload_json));
          return wire.isOk() && acceptObjectId(wire.value) === followId;
        }),
      "Accept not in B inbox_activities",
      40,
    );
    console.log("ok Accept on B (host-driven hop)");
  } else {
    console.log("ok Accept on B (worker-delivered)");
  }

  console.log("PASS federation accept");
};

main().catch((error: unknown) => fail("unhandled", error));
