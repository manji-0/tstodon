#!/usr/bin/env node
import {
  A,
  B,
  A_DOMAIN,
  B_DOMAIN,
  authHeaders,
  fail,
  fetchApPerson,
  fetchMastodonAccount,
  getJsonParsed,
  waitOk,
} from "./lib.js";
import { ApPerson, WebFinger } from "./schemas.js";

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice@e2e.example");
  const bobHeaders = await authHeaders("bob@e2e.example");

  const alice = await fetchMastodonAccount(A, aliceHeaders, "provision alice on A");
  const bob = await fetchMastodonAccount(B, bobHeaders, "provision bob on B");
  console.log(`ok provisioned @${alice.username} on A, @${bob.username} on B`);

  const wfA = await getJsonParsed(
    `${A}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${alice.username}@${A_DOMAIN}`)}`,
    WebFinger.parse,
    "webfinger A",
  );
  if (wfA.status !== 200) {
    return fail("webfinger A", wfA);
  }
  const actorAHref = WebFinger.selfHref(wfA.body);
  if (!actorAHref) {
    return fail("webfinger A self link", wfA.body);
  }

  const wfB = await getJsonParsed(
    `${B}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${bob.username}@${B_DOMAIN}`)}`,
    WebFinger.parse,
    "webfinger B",
  );
  if (wfB.status !== 200) {
    return fail("webfinger B", wfB);
  }
  const actorBHref = WebFinger.selfHref(wfB.body);
  if (!actorBHref) {
    return fail("webfinger B self link", wfB.body);
  }
  console.log("ok webfinger A/B");

  if (!actorAHref.startsWith(A) || !actorBHref.startsWith(B)) {
    return fail("actor href origins", { actorAHref, actorBHref, A, B });
  }

  const actorA = await fetchApPerson(actorAHref, "actor document A");
  await fetchApPerson(actorBHref, "actor document B");
  console.log("ok actor documents");

  const cross = await getJsonParsed(actorAHref, ApPerson.parse, "cross-instance actor fetch", {
    headers: { Accept: "application/activity+json" },
  });
  if (cross.status !== 200 || cross.body.id !== actorA.id) {
    return fail("cross-instance actor fetch", cross);
  }
  console.log("ok cross-instance actor fetch");
  console.log("PASS federation smoke");
};

main().catch((error: unknown) => fail("unhandled", error));
