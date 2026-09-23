#!/usr/bin/env node
/**
 * Minimal 2-instance federation smoke for process-compose.
 * Assumes tstodon-a (:8791) and tstodon-b (:8792) are healthy.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const josePath = require.resolve("jose", { paths: [path.join(root, "packages/worker"), root] });
const { SignJWT, importJWK } = await import(josePath);

const A = process.env.E2E_A_ORIGIN ?? "http://127.0.0.1:8791";
const B = process.env.E2E_B_ORIGIN ?? "http://127.0.0.1:8792";
const A_DOMAIN = process.env.E2E_A_DOMAIN ?? "127.0.0.1:8791";
const B_DOMAIN = process.env.E2E_B_DOMAIN ?? "127.0.0.1:8792";

const LOCAL_PRIVATE_JWK = {
  kty: "RSA",
  n: "qHE50MFXgxUeSKwP4ChF1TRN7gvR1z4bRcTIc7Jcr6qTrccio5BjeveN7dxj8pP985tYQMVI9sx81vEA7v38KzY0Q9UqEgZzd7VP_TGJEm4fxaP7dZSVQWTvrTxNpqCCPml4rc3nNgABRWniSgwCWR1A7d7mpOTicxXG6PApWAPDuRGdBNq2hnkm2fkFSKKf_oyaXjlRZJMYiMR8pOoCb9xrSUKTzrUjK_AvSmt3CcnJwMqMMVn_ZP7-nRi-OogwkOjW0NyUzIle7KQkMYDhHGRMUnZjj6Qwo0yBzvJXXuBjusHTPYHPlSVnY4k9uxA2SojnCUgrM20tGLsmUofpFw",
  e: "AQAB",
  kid: "tstodon-local-access",
  alg: "RS256",
  use: "sig",
  d: "AsdDVd8qi134zugPpvnjFP403t1RC8TZfFAfolDp2Hfu0an8N0h1a5zTuX2uJF0ujisczIy0hGWhFYaKJmcIFsphGFFWzU9P7kSOWjXL9gLdAUyQJENcJuT8UxYwjbQOEet5cxx3WNutKbDya5hBHaku3f2UPloMJivQyRzVAb-fRdZR4ImfmfHbeKRgB3TGETAfaR1hJGWSmPEZVOrLBDo6hGoccJ_-4L1j5nCpZVZ2grXOqFqofotZmeB8aGNDaWAe365FmD4vO9iv5p0Yu5s-OPT4sfKkYFhz_59JyoW4mGB0qoYzDgOM_Q5edHKqhZVMOe6GDHEz6qwBVRYnIQ",
  p: "4gAUZ8Fnfjs1bKZk5SR0c7Zh5OUqIMguH63RxfF3pe45P5U7ZLtqdP6SrrMhYbPTrBNsQcQydsVGJgaRyxf553A3QiSP4WYu7cvqHCiJ1dMJj251yVUta2-CFLSDHv3R0bjp4E_1_MgVgfaWTlfk2haRyeahVBq1nMuHUpTUYEc",
  q: "vs03DytptttgweXwU1V8Muv_8J7_-QMBCU-Iypb_wdwLMbVM18CKB0iJKXty2teIvfY7oNOfKZyuJ6GjEEshKQGLZOIF07jRcsc6ckuC69wv6hNR6dF5TG2dWW32lQUM4oCHa7WwZKFYIAM-W-SuFzrgMAbENdTteR-D3tmH6LE",
  dp: "wDdJI6X_HAHHwo0TK0ECOphYUpIGbrNTZ2YzEKP7G4mt70JBrb8pIDCVGTkJn0uPML-kR5tTQGkw7I6R2aaeyhVLKlpmdVKvf1j72M8xzEcdznwoegCUDNheTrXo_6bpmfIoGLxpf4G9qTfNRvzCjCq9_HbHp_y_kogYpEgpCWk",
  dq: "bxayYO2oziMqUZpb81kJR-iqCmG4rTW3i8E35qRF4owIJHfndpKOirEL0xAiDhKBdgCANSIhQCwOJdrxQtJLS0Gv9Bu4ws2PfOFMQTF_121KpGF9RsKEeiA0BdaFQ7w-BT5KGkcdnWlnErRwwTYCulm4H55A7Qq8_NGBiOVkQPE",
  qi: "A3Uy5wXgpeDH9l1qxhKtN_O-3F6Ia_mhWeG6mTaNUlKXjI6cJ4rjdEnQCZaZk8IPGWfDutxG9-FQgklx_TgHFc0jdJGuabtNl3QlYTY-QSsKcfq1qQaRRC-n3CB6MiP-CEm3E-6ufbAE1J2YOqgkfv_sB9WvCWPkzJANZJSbEFk",
};

const fail = (message, detail) => {
  console.error(`FAIL: ${message}`, detail ?? "");
  process.exit(1);
};

const getJson = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

const waitOk = async (url, label) => {
  for (let i = 0; i < 90; i += 1) {
    try {
      const { status } = await getJson(url);
      if (status === 200) {
        console.log(`ok ${label}`);
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${label} not ready`, url);
};

const authHeaders = async (email) => {
  const key = await importJWK(LOCAL_PRIVATE_JWK, "RS256");
  const token = await new SignJWT({ email, type: "app", groups: [], custom: { groups: [] } })
    .setProtectedHeader({ alg: "RS256", kid: "tstodon-local-access", typ: "JWT" })
    .setIssuer("https://tstodon.cloudflareaccess.com")
    .setAudience("tstodon-local-aud")
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
  return { Authorization: `Bearer ${token}` };
};

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
