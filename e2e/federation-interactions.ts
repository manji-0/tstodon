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
  authHeaders,
  expectParsed,
  fail,
  fetchApPerson,
  fetchMastodonAccount,
  getJsonParsed,
  postSignedInbox,
  seedRemoteActor,
  waitOk,
  waitRows,
} from "./lib.js";
import {
  ApWireActivity,
  MastodonStatus,
  RemoteAnnounceRow,
  RemoteFavouriteRow,
  RemoteFollowRow,
} from "./schemas.js";

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice-ix@e2e.example");
  const bobHeaders = await authHeaders("bob-ix@e2e.example");
  const alice = await fetchMastodonAccount(A, aliceHeaders, "provision");
  const bob = await fetchMastodonAccount(B, bobHeaders, "provision");
  const aliceUser = alice.username;
  const bobUser = bob.username;
  const aliceActor = `${A}/users/${aliceUser}`;
  const bobActor = `${B}/users/${bobUser}`;
  const bobKeyId = `${bobActor}#main-key`;
  const aliceInbox = `${A}/inbox`;
  console.log(`ok users @${aliceUser}@${A_DOMAIN}, @${bobUser}@${B_DOMAIN}`);

  const bobDoc = await fetchApPerson(bobActor, "bob actor document");
  const aliceDoc = await fetchApPerson(aliceActor, "alice actor document");
  seedRemoteActor("a", bobDoc);
  seedRemoteActor("b", aliceDoc);

  const bobKey = accountPrivateKeyJwk("b", bobUser);
  const followId = `${B}/activities/follow-ix-${Date.now()}`;
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
    `SELECT remote_actor_uri, follow_kind FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    RemoteFollowRow.parseMany,
    (rows) => rows.some((r) => r.follow_kind === "Accepted"),
    "follow not Accepted",
  );
  console.log("ok Follow");

  const undoFollowActivity = expectParsed("Undo Follow activity", ApWireActivity.undoFollow.parse, {
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
  const undoFollow = await postSignedInbox(aliceInbox, bobKey, bobKeyId, undoFollowActivity);
  if (undoFollow.status !== 202) {
    return fail("Undo Follow", undoFollow);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri FROM remote_follows WHERE remote_actor_uri = '${bobActor}'`,
    RemoteFollowRow.parseMany,
    (rows) => rows.length === 0,
    "Undo Follow did not remove remote_follows",
  );
  console.log("ok Undo Follow");

  const created = await getJsonParsed(
    `${A}/api/v1/statuses`,
    MastodonStatus.parse,
    "create status",
    {
      method: "POST",
      headers: { ...aliceHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: `interact me ${Date.now()}`, visibility: "public" }),
    },
  );
  if (created.status !== 200) {
    return fail("create status", created);
  }
  const statusId = created.body.id;
  const statusUri = `${aliceActor}/statuses/${statusId}`;
  console.log(`ok alice status ${statusId}`);

  const likeId = `${B}/activities/like-ix-${Date.now()}`;
  const likeActivity = expectParsed("Like activity", ApWireActivity.like.parse, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: likeId,
    type: "Like",
    actor: bobActor,
    object: statusUri,
  });
  const like = await postSignedInbox(aliceInbox, bobKey, bobKeyId, likeActivity);
  if (like.status !== 202) {
    return fail("Like", like);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri, status_id FROM remote_favourites WHERE status_id = '${statusId}'`,
    RemoteFavouriteRow.parseMany,
    (rows) => rows.some((r) => r.remote_actor_uri === bobActor),
    "Like not in remote_favourites",
  );
  console.log("ok Like");

  const announceId = `${B}/activities/announce-ix-${Date.now()}`;
  const announceActivity = expectParsed("Announce activity", ApWireActivity.announce.parse, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: announceId,
    type: "Announce",
    actor: bobActor,
    object: statusUri,
  });
  const announce = await postSignedInbox(aliceInbox, bobKey, bobKeyId, announceActivity);
  if (announce.status !== 202) {
    return fail("Announce", announce);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri, status_id FROM remote_announces WHERE status_id = '${statusId}'`,
    RemoteAnnounceRow.parseMany,
    (rows) => rows.some((r) => r.remote_actor_uri === bobActor),
    "Announce not in remote_announces",
  );
  console.log("ok Announce");

  const counted = await getJsonParsed(
    `${A}/api/v1/statuses/${statusId}`,
    MastodonStatus.parse,
    "status counts fetch",
    { headers: aliceHeaders },
  );
  if (counted.status !== 200) {
    return fail("status counts fetch", counted);
  }
  const favouritesCount = counted.body.favourites_count ?? 0;
  const reblogsCount = counted.body.reblogs_count ?? 0;
  if (favouritesCount < 1 || reblogsCount < 1) {
    return fail("status counts missing remote interactions", counted.body);
  }
  console.log("ok favourites_count/reblogs_count");

  const undoLikeActivity = expectParsed("Undo Like activity", ApWireActivity.undoLike.parse, {
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
  const undoLike = await postSignedInbox(aliceInbox, bobKey, bobKeyId, undoLikeActivity);
  if (undoLike.status !== 202) {
    return fail("Undo Like", undoLike);
  }
  await waitRows(
    "a",
    `SELECT remote_actor_uri FROM remote_favourites WHERE status_id = '${statusId}' AND remote_actor_uri = '${bobActor}'`,
    RemoteFavouriteRow.parseMany,
    (rows) => rows.length === 0,
    "Undo Like did not clear remote_favourites",
  );
  console.log("ok Undo Like");

  console.log("PASS federation interactions");
};

main().catch((error: unknown) => fail("unhandled", error));
