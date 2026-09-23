#!/usr/bin/env node
import {
  A,
  B,
  A_DOMAIN,
  B_DOMAIN,
  authHeaders,
  fail,
  getJson,
  isRecord,
  requireUsername,
  waitOk,
} from "./lib.js";

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice@e2e.example");
  const bobHeaders = await authHeaders("bob@e2e.example");

  const alice = await getJson(`${A}/api/v1/accounts/verify_credentials`, {
    headers: aliceHeaders,
  });
  if (alice.status !== 200) {
    return fail("provision alice on A", alice);
  }
  const bob = await getJson(`${B}/api/v1/accounts/verify_credentials`, {
    headers: bobHeaders,
  });
  if (bob.status !== 200) {
    return fail("provision bob on B", bob);
  }
  const aliceUsername = requireUsername(alice.body, "provision alice body");
  const bobUsername = requireUsername(bob.body, "provision bob body");
  console.log(`ok provisioned @${aliceUsername} on A, @${bobUsername} on B`);

  const wfA = await getJson(
    `${A}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${aliceUsername}@${A_DOMAIN}`)}`,
  );
  if (wfA.status !== 200 || !isRecord(wfA.body) || !Array.isArray(wfA.body.links)) {
    return fail("webfinger A", wfA);
  }
  const wfALinks = wfA.body.links;
  const wfASelf = wfALinks.find(
    (l: unknown): l is { rel: string; href: string } =>
      isRecord(l) && l.rel === "self" && typeof l.href === "string",
  );
  if (!wfASelf) {
    return fail("webfinger A", wfA);
  }
  const wfB = await getJson(
    `${B}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${bobUsername}@${B_DOMAIN}`)}`,
  );
  if (wfB.status !== 200 || !isRecord(wfB.body) || !Array.isArray(wfB.body.links)) {
    return fail("webfinger B", wfB);
  }
  const wfBLinks = wfB.body.links;
  const wfBSelf = wfBLinks.find(
    (l: unknown): l is { rel: string; href: string } =>
      isRecord(l) && l.rel === "self" && typeof l.href === "string",
  );
  if (!wfBSelf) {
    return fail("webfinger B", wfB);
  }
  console.log("ok webfinger A/B");

  const actorAHref = wfASelf.href;
  const actorBHref = wfBSelf.href;
  if (!actorAHref.startsWith(A) || !actorBHref.startsWith(B)) {
    return fail("actor href origins", { actorAHref, actorBHref, A, B });
  }

  const actorA = await getJson(actorAHref, {
    headers: { Accept: "application/activity+json" },
  });
  const actorB = await getJson(actorBHref, {
    headers: { Accept: "application/activity+json" },
  });
  if (actorA.status !== 200 || !isRecord(actorA.body) || actorA.body.type !== "Person") {
    return fail("actor document A", actorA);
  }
  const actorAId = actorA.body.id;
  if (actorB.status !== 200 || !isRecord(actorB.body) || actorB.body.type !== "Person") {
    return fail("actor document B", actorB);
  }
  console.log("ok actor documents");

  const cross = await getJson(actorAHref, {
    headers: { Accept: "application/activity+json" },
  });
  if (cross.status !== 200 || !isRecord(cross.body) || cross.body.id !== actorAId) {
    return fail("cross-instance actor fetch", cross);
  }
  console.log("ok cross-instance actor fetch");
  console.log("PASS federation smoke");
};

main().catch((error: unknown) => fail("unhandled", error));
