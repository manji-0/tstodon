#!/usr/bin/env node
/**
 * E2E: Bob@B follows Alice@A through B's client API; A accepts. Alice posts a
 * status with an image; A delivers the `Create` to B, and Bob's home timeline
 * shows it with the image as A shows it.
 */
import { A, B, api, fail, followRemote, getJsonParsed, signUp, waitFor, waitOk } from "./lib.js";
import { ApiAccount, ApiStatus, MastodonStatus, MastodonStatusMedia } from "./schemas.js";

// A real 1x1 PNG: uploads must be readable images, as their metadata is stripped.
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "instance A");
  await waitOk(`${B}/.well-known/nodeinfo`, "instance B");

  const alice = await signUp(A, "alice-fc");
  const bob = await signUp(B, "bob-fc");
  console.log(`ok users ${alice.acct}, ${bob.acct}`);

  await followRemote(bob, alice);
  console.log("ok Follow → Accept: bob follows alice");
  await waitFor("A counts bob as alice's follower", async () => {
    const account = await api(
      A,
      alice.headers,
      `/api/v1/accounts/${alice.id}`,
      ApiAccount.parse,
      "alice",
    );
    return account.followers_count === 1 ? account : undefined;
  });
  console.log("ok A counts bob as alice's follower");

  const form = new FormData();
  form.set("file", new File([png], "alice.png", { type: "image/png" }));
  const uploaded = await getJsonParsed(`${A}/api/v2/media`, MastodonStatus.parse, "alice upload", {
    method: "POST",
    headers: alice.headers,
    body: form,
  });
  if (uploaded.status !== 200) {
    return fail("alice upload media", uploaded);
  }

  const created = await api(A, alice.headers, "/api/v1/statuses", ApiStatus.parse, "alice posts", {
    method: "POST",
    body: {
      status: `hello bob from alice e2e ${Date.now()}`,
      visibility: "public",
      media_ids: [uploaded.body.id],
      media_attributes: [{ id: uploaded.body.id, description: "alice's e2e picture" }],
    },
  });
  const seenByAlice = await api(
    A,
    alice.headers,
    `/api/v1/statuses/${created.id}`,
    MastodonStatusMedia.parse,
    "alice reads her status",
  );
  const aliceMedia = seenByAlice.media_attachments;
  if (aliceMedia.length !== 1 || aliceMedia[0]?.description !== "alice's e2e picture") {
    return fail("alice status lacks its media", seenByAlice);
  }
  console.log(`ok alice created status ${created.id} with media`);

  const onB = await waitFor("alice's status on bob's home", async () => {
    const home = await api(B, bob.headers, "/api/v1/timelines/home", ApiStatus.parseMany, "home");
    return home.find((status) => status.uri === created.uri);
  });
  if (onB.account.uri !== alice.uri) {
    return fail("B attributes alice's status to someone else", onB);
  }
  console.log("ok Create delivered: alice's status on bob's home", onB.id);

  const seenByBob = await api(
    B,
    bob.headers,
    `/api/v1/statuses/${onB.id}`,
    MastodonStatusMedia.parse,
    "bob reads alice's status",
  );
  const bobMedia = seenByBob.media_attachments.map(({ type, url, description }) => ({
    type,
    url,
    description,
  }));
  if (JSON.stringify(bobMedia) !== JSON.stringify(aliceMedia)) {
    return fail("B does not show A's media as A does", { onA: aliceMedia, onB: bobMedia });
  }
  console.log("ok B shows A's image", bobMedia[0]?.url);
  console.log("PASS federation follow→create");
};

main().catch((error: unknown) => fail("unhandled", error));
