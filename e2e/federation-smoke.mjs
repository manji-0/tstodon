#!/usr/bin/env node
import { A, B, A_DOMAIN, B_DOMAIN, authHeaders, fail, getJson, waitOk } from "./lib.mjs";

const main = async () => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const aliceHeaders = await authHeaders("alice@e2e.example");
  const bobHeaders = await authHeaders("bob@e2e.example");

  const alice = await getJson(`${A}/api/v1/accounts/verify_credentials`, {
    headers: aliceHeaders,
  });
  if (alice.status !== 200) {
    fail("provision alice on A", alice);
  }
  const bob = await getJson(`${B}/api/v1/accounts/verify_credentials`, {
    headers: bobHeaders,
  });
  if (bob.status !== 200) {
    fail("provision bob on B", bob);
  }
  console.log(`ok provisioned @${alice.body.username} on A, @${bob.body.username} on B`);

  const wfA = await getJson(
    `${A}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${alice.body.username}@${A_DOMAIN}`)}`,
  );
  if (wfA.status !== 200 || !wfA.body?.links?.[0]?.href) {
    fail("webfinger A", wfA);
  }
  const wfB = await getJson(
    `${B}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${bob.body.username}@${B_DOMAIN}`)}`,
  );
  if (wfB.status !== 200 || !wfB.body?.links?.[0]?.href) {
    fail("webfinger B", wfB);
  }
  console.log("ok webfinger A/B");

  const actorAHref = wfA.body.links.find((l) => l.rel === "self")?.href;
  const actorBHref = wfB.body.links.find((l) => l.rel === "self")?.href;
  if (!actorAHref?.startsWith(A) || !actorBHref?.startsWith(B)) {
    fail("actor href origins", { actorAHref, actorBHref, A, B });
  }

  const actorA = await getJson(actorAHref, {
    headers: { Accept: "application/activity+json" },
  });
  const actorB = await getJson(actorBHref, {
    headers: { Accept: "application/activity+json" },
  });
  if (actorA.status !== 200 || actorA.body?.type !== "Person") {
    fail("actor document A", actorA);
  }
  if (actorB.status !== 200 || actorB.body?.type !== "Person") {
    fail("actor document B", actorB);
  }
  console.log("ok actor documents");

  const cross = await getJson(actorAHref, {
    headers: { Accept: "application/activity+json" },
  });
  if (cross.status !== 200 || cross.body?.id !== actorA.body.id) {
    fail("cross-instance actor fetch", cross);
  }
  console.log("ok cross-instance actor fetch");
  console.log("PASS federation smoke");
};

main().catch((error) => fail("unhandled", error));
