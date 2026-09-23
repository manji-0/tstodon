#!/usr/bin/env node
/**
 * E2E interactions: Undo Follow, Like, Announce, Undo Like against dual instances.
 */
import {
  A,
  B,
  A_DOMAIN,
  B_DOMAIN,
  accountPrivateKeyJwk,
  asActorDocument,
  authHeaders,
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

  const aliceHeaders = await authHeaders("alice-ix@e2e.example");
  const bobHeaders = await authHeaders("bob-ix@e2e.example");
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
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const bobDoc = await getJson(bobActor, { headers: { Accept: "application/activity+json" } });
  const aliceDoc = await getJson(aliceActor, {
    headers: { Accept: "application/activity+json" },
  });
  if (bobDoc.status !== 200 || aliceDoc.status !== 200) {
    return fail("actor docs", { bobDoc, aliceDoc });
  }
  seedRemoteActor("a", asActorDocument(bobDoc.body, "bob actor document"));
  seedRemoteActor("b", asActorDocument(aliceDoc.body, "alice actor document"));

  const bobKey = accountPrivateKeyJwk("b", bobUser);
  const followId = `${B}/activities/follow-ix-${Date.now()}`;
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
    `SELECT remote_actor_uri, follow_kind FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    (rows: D1Row[]) => rows.some((r) => r.follow_kind === "Accepted"),
    "follow not Accepted",
  );
  console.log("ok Follow");

  const undoFollow = await postSignedInbox(aliceInbox, bobKey, bobKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${B}/activities/undo-follow-ix-${Date.now()}`,
    type: "Undo",
    actor: bobActor,
    object: {
      id: followId,
      type: "Follow",
      actor: bobActor,
      object: aliceActor,
    },
  });
  if (undoFollow.status !== 202) {
    return fail("Undo Follow", undoFollow);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    (rows: D1Row[]) => rows.length === 0,
    "Undo Follow did not remove remote_follows",
  );
  console.log("ok Undo Follow");

  // Re-follow so Like/Announce targets a local status after Create path optional;
  // Alice creates a local status first, Bob likes/announces it without needing follow.
  const created = await getJson(`${A}/api/v1/statuses`, {
    method: "POST",
    headers: { ...aliceHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ status: `interact me ${Date.now()}`, visibility: "public" }),
  });
  if (created.status !== 200 || !isRecord(created.body) || created.body.id == null) {
    return fail("create status", created);
  }
  const statusId = asString(created.body.id);
  const statusUri = `${aliceActor}/statuses/${statusId}`;
  console.log(`ok alice status ${statusId}`);

  const likeId = `${B}/activities/like-ix-${Date.now()}`;
  const like = await postSignedInbox(aliceInbox, bobKey, bobKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: likeId,
    type: "Like",
    actor: bobActor,
    object: statusUri,
  });
  if (like.status !== 202) {
    return fail("Like", like);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri, status_id FROM remote_favourites WHERE status_id = '${statusId}'`,
    (rows: D1Row[]) => rows.some((r) => r.remote_actor_uri === bobActor),
    "Like not in remote_favourites",
  );
  console.log("ok Like");

  const announceId = `${B}/activities/announce-ix-${Date.now()}`;
  const announce = await postSignedInbox(aliceInbox, bobKey, bobKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: announceId,
    type: "Announce",
    actor: bobActor,
    object: statusUri,
  });
  if (announce.status !== 202) {
    return fail("Announce", announce);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri, status_id FROM remote_announces WHERE status_id = '${statusId}'`,
    (rows: D1Row[]) => rows.some((r) => r.remote_actor_uri === bobActor),
    "Announce not in remote_announces",
  );
  console.log("ok Announce");

  const counted = await getJson(`${A}/api/v1/statuses/${statusId}`, { headers: aliceHeaders });
  if (counted.status !== 200 || !isRecord(counted.body)) {
    return fail("status counts fetch", counted);
  }
  const countedBody = counted.body;
  const favouritesCount =
    typeof countedBody.favourites_count === "number" ? countedBody.favourites_count : 0;
  const reblogsCount =
    typeof countedBody.reblogs_count === "number" ? countedBody.reblogs_count : 0;
  if (favouritesCount < 1 || reblogsCount < 1) {
    return fail("status counts missing remote interactions", countedBody);
  }
  console.log("ok favourites_count/reblogs_count");

  const undoLike = await postSignedInbox(aliceInbox, bobKey, bobKeyId, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${B}/activities/undo-like-ix-${Date.now()}`,
    type: "Undo",
    actor: bobActor,
    object: {
      id: likeId,
      type: "Like",
      object: statusUri,
    },
  });
  if (undoLike.status !== 202) {
    return fail("Undo Like", undoLike);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri FROM remote_favourites WHERE status_id = '${statusId}' AND remote_actor_uri = '${bobActor}'`,
    (rows: D1Row[]) => rows.length === 0,
    "Undo Like did not clear remote_favourites",
  );
  console.log("ok Undo Like");

  console.log("PASS federation interactions");
};

main().catch((error: unknown) => fail("unhandled", error));
