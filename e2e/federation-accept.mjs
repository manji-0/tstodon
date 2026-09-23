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

  const aliceHeaders = await authHeaders("alice-ac@e2e.example");
  const bobHeaders = await authHeaders("bob-ac@e2e.example");
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
  const aliceInbox = `${A}/inbox`;
  const bobInbox = `${B}/inbox`;
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const bobDoc = await getJson(bobActor, { headers: { Accept: "application/activity+json" } });
  const aliceDoc = await getJson(aliceActor, {
    headers: { Accept: "application/activity+json" },
  });
  seedRemoteActor("a", bobDoc.body);
  seedRemoteActor("b", aliceDoc.body);

  const bobKey = accountPrivateKeyJwk("b", bobUser);
  const followId = `${B}/activities/follow-ac-${Date.now()}`;
  const follow = await postSignedInbox(aliceInbox, bobKey, bobKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: followId,
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
  console.log("ok Follow Accepted in DB");

  const acceptRows = await waitRows(
    "a",
    `SELECT id, kind, payload_json FROM outbound_activities WHERE kind = 'Accept' ORDER BY created_at DESC LIMIT 5`,
    (rows) =>
      rows.some((r) => {
        try {
          const payload = JSON.parse(r.payload_json);
          return payload?.type === "Accept" && payload?.object?.id === followId;
        } catch {
          return false;
        }
      }),
    "Accept outbound activity missing on A",
  );
  const acceptActivityRow = acceptRows.find((r) => {
    try {
      return JSON.parse(r.payload_json)?.object?.id === followId;
    } catch {
      return false;
    }
  });
  console.log("ok Accept outbound on A", acceptActivityRow.id);

  await waitRows(
    "a",
    `SELECT inbox_url FROM outbox_deliveries WHERE activity_id = '${acceptActivityRow.id}'`,
    (rows) => rows.some((r) => String(r.inbox_url).includes("8792")),
    "Accept missing outbox target to B",
  );
  console.log("ok Accept targeted to B");

  // Host-drive Accept if workerd could not deliver over loopback.
  let acceptOnB = d1Json(
    "b",
    `SELECT activity_id, kind, payload_json FROM inbox_activities WHERE kind = 'Accept' ORDER BY rowid DESC LIMIT 10`,
  ).some((r) => {
    try {
      return JSON.parse(r.payload_json)?.object?.id === followId;
    } catch {
      return false;
    }
  });
  if (!acceptOnB) {
    const aliceKey = accountPrivateKeyJwk("a", aliceUser);
    const payload = JSON.parse(acceptActivityRow.payload_json);
    payload.id = `${payload.id}-host-${Date.now()}`;
    const delivered = await postSignedInbox(bobInbox, aliceKey, `${aliceActor}#main-key`, payload);
    if (delivered.status !== 202 && delivered.status !== 200) {
      fail("host-driven Accept", delivered);
    }
    await waitRows(
      "b",
      `SELECT payload_json FROM inbox_activities WHERE kind = 'Accept' ORDER BY rowid DESC LIMIT 10`,
      (rows) =>
        rows.some((r) => {
          try {
            return JSON.parse(r.payload_json)?.object?.id === followId;
          } catch {
            return false;
          }
        }),
      "Accept not in B inbox_activities",
    );
    console.log("ok Accept on B (host-driven hop)");
  } else {
    console.log("ok Accept on B (worker-delivered)");
  }

  console.log("PASS federation accept");
};

main().catch((error) => fail("unhandled", error));
