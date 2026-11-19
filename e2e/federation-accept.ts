#!/usr/bin/env node
/**
 * E2E: Bob@B follows Alice@A through B's client API → A records the follow
 * and sends an `Accept` of B's `Follow` → B handles the `Accept` and holds
 * the follow as accepted.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { A, B, d1Rows, fail, followRemote, signUp, waitOk, waitRows } from "./lib.js";
import {
  ApWireActivity,
  acceptObjectId,
  InboxActivityRow,
  OutboundActivityRow,
  RemoteFollowRow,
} from "./schemas.js";

const OutboundFollowRows = schemaResult(
  z.array(z.object({ follow_activity_id: z.string().min(1), state: z.string() })),
);

const acceptsFollow = (payload: string | undefined, followId: string): boolean => {
  if (payload === undefined) {
    return false;
  }
  const wire = ApWireActivity.accept.parse(JSON.parse(payload));
  return wire.isOk() && acceptObjectId(wire.value) === followId;
};

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice-ac");
  const bob = await signUp(B, "bob-ac");
  console.log(`ok users ${alice.acct}, ${bob.acct}`);

  await followRemote(bob, alice);
  console.log("ok bob follows alice: B holds the follow as accepted");

  const [held] = d1Rows(
    "b",
    `SELECT follow_activity_id, state FROM outbound_follows
      WHERE actor_uri = '${alice.uri}'
        AND account_id = (SELECT id FROM accounts WHERE username = '${bob.username}')`,
    OutboundFollowRows,
    "B's outbound follow",
  );
  if (held?.state !== "Accepted") {
    return fail("B does not hold bob's follow of alice as Accepted", held);
  }
  const followId = held.follow_activity_id;
  console.log("ok B's Follow", followId);

  await waitRows(
    "a",
    `SELECT follow_kind FROM remote_follows WHERE remote_actor_uri = '${bob.uri}'`,
    RemoteFollowRow.parseMany,
    (rows) => rows.some((row) => row.follow_kind === "Accepted"),
    "A did not record bob's follow as Accepted",
    40,
  );
  console.log("ok A records the follow as Accepted");

  await waitRows(
    "a",
    "SELECT id, kind, payload_json FROM outbound_activities WHERE kind = 'Accept' ORDER BY created_at DESC LIMIT 20",
    OutboundActivityRow.parseMany,
    (rows) => rows.some((row) => acceptsFollow(row.payload_json, followId)),
    "A sent no Accept of B's Follow",
    40,
  );
  console.log("ok A sent the Accept of B's Follow");

  await waitRows(
    "b",
    "SELECT activity_id, kind, payload_json FROM inbox_activities WHERE kind = 'Accept' ORDER BY rowid DESC LIMIT 20",
    InboxActivityRow.parseMany,
    (rows) => rows.some((row) => acceptsFollow(row.payload_json, followId)),
    "B's inbox did not take A's Accept",
    40,
  );
  console.log("ok B handled A's Accept");

  console.log("PASS federation accept");
};

main().catch((error: unknown) => fail("unhandled", error));
