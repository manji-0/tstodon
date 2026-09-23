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
  asActorDocument,
  authHeaders,
  d1Json,
  fail,
  getJson,
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

  const aliceHeaders = await authHeaders("alice-ac@e2e.example");
  const bobHeaders = await authHeaders("bob-ac@e2e.example");
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
  const aliceInbox = `${A}/inbox`;
  const bobInbox = `${B}/inbox`;
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const bobDoc = await getJson(bobActor, { headers: { Accept: "application/activity+json" } });
  const aliceDoc = await getJson(aliceActor, {
    headers: { Accept: "application/activity+json" },
  });
  seedRemoteActor("a", asActorDocument(bobDoc.body, "bob actor document"));
  seedRemoteActor("b", asActorDocument(aliceDoc.body, "alice actor document"));

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
    return fail("Follow", follow);
  }
  await waitRows(
    "a",
    `SELECT follow_kind FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    (rows: D1Row[]) => rows.some((r) => r.follow_kind === "Accepted"),
    "follow not Accepted",
    40,
  );
  console.log("ok Follow Accepted in DB");

  const acceptRows = await waitRows(
    "a",
    `SELECT id, kind, payload_json FROM outbound_activities WHERE kind = 'Accept' ORDER BY created_at DESC LIMIT 5`,
    (rows: D1Row[]) =>
      rows.some((r) => {
        try {
          if (typeof r.payload_json !== "string") {
            return false;
          }
          const payload: unknown = JSON.parse(r.payload_json);
          return (
            isRecord(payload) &&
            payload.type === "Accept" &&
            isRecord(payload.object) &&
            payload.object.id === followId
          );
        } catch {
          return false;
        }
      }),
    "Accept outbound activity missing on A",
    40,
  );
  const acceptActivityRow = acceptRows.find((r) => {
    try {
      if (typeof r.payload_json !== "string") {
        return false;
      }
      const payload: unknown = JSON.parse(r.payload_json);
      return isRecord(payload) && isRecord(payload.object) && payload.object.id === followId;
    } catch {
      return false;
    }
  });
  if (!acceptActivityRow || typeof acceptActivityRow.id !== "string") {
    return fail("Accept outbound activity missing on A", acceptRows);
  }
  if (typeof acceptActivityRow.payload_json !== "string") {
    return fail("Accept payload missing", acceptActivityRow);
  }
  const acceptPayloadJson = acceptActivityRow.payload_json;
  const acceptActivityId = acceptActivityRow.id;
  console.log("ok Accept outbound on A", acceptActivityId);

  await waitRows(
    "a",
    `SELECT inbox_url FROM outbox_deliveries WHERE activity_id = '${acceptActivityId}'`,
    (rows: D1Row[]) => rows.some((r) => String(r.inbox_url).includes("8792")),
    "Accept missing outbox target to B",
    40,
  );
  console.log("ok Accept targeted to B");

  // Host-drive Accept if workerd could not deliver over loopback.
  const acceptOnB = d1Json(
    "b",
    `SELECT activity_id, kind, payload_json FROM inbox_activities WHERE kind = 'Accept' ORDER BY rowid DESC LIMIT 10`,
  ).some((r) => {
    try {
      if (typeof r.payload_json !== "string") {
        return false;
      }
      const payload: unknown = JSON.parse(r.payload_json);
      return isRecord(payload) && isRecord(payload.object) && payload.object.id === followId;
    } catch {
      return false;
    }
  });
  if (!acceptOnB) {
    const aliceKey = accountPrivateKeyJwk("a", aliceUser);
    const payload = JSON.parse(acceptPayloadJson) as Record<string, unknown>;
    payload.id = `${String(payload.id)}-host-${Date.now()}`;
    const delivered = await postSignedInbox(bobInbox, aliceKey, `${aliceActor}#main-key`, payload);
    if (delivered.status !== 202 && delivered.status !== 200) {
      return fail("host-driven Accept", delivered);
    }
    await waitRows(
      "b",
      `SELECT payload_json FROM inbox_activities WHERE kind = 'Accept' ORDER BY rowid DESC LIMIT 10`,
      (rows: D1Row[]) =>
        rows.some((r) => {
          try {
            if (typeof r.payload_json !== "string") {
              return false;
            }
            const parsed: unknown = JSON.parse(r.payload_json);
            return isRecord(parsed) && isRecord(parsed.object) && parsed.object.id === followId;
          } catch {
            return false;
          }
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
