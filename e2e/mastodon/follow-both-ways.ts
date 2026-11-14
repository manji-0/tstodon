#!/usr/bin/env node
/**
 * Interop: tstodon and a real Mastodon follow each other through their client
 * APIs. Alice@tstodon follows Mona@Mastodon and gets Mona's post on her home
 * timeline; Mona follows Alice and gets Alice's post on hers.
 * Needs the stack from `bootstrap.sh` and the variables in `.state/e2e.env`.
 */
import { schemaResult } from "@tstodon/core";
import { z } from "zod";
import { A, api, fail, followRemote, signUp, waitFor, waitOk } from "../lib.js";
import { ApiStatus } from "../schemas.js";
import { MASTODON, mastodonUser } from "./lib.js";

const MastodonStatus = z.looseObject({ id: z.string(), uri: z.string(), content: z.string() });
const MastodonStatuses = schemaResult(z.array(MastodonStatus));

const main = async (): Promise<void> => {
  await waitOk(`${A}/.well-known/nodeinfo`, "tstodon");
  await waitOk(`${MASTODON}/api/v2/instance`, "Mastodon");

  const alice = await signUp(A, "alice");
  const mona = await mastodonUser("mona");
  console.log(`ok users ${alice.acct}, ${mona.acct}`);

  await followRemote(alice, mona);
  console.log("ok tstodon → Mastodon: alice follows mona (Follow → Accept)");

  const monaText = `mona to her followers ${Date.now()}`;
  const monaPost = await api(
    MASTODON,
    mona.headers,
    "/api/v1/statuses",
    schemaResult(MastodonStatus),
    "mona posts",
    { method: "POST", body: { status: monaText, visibility: "public" } },
  );
  const onAliceHome = await waitFor("mona's post on alice's home timeline", async () => {
    const home = await api(A, alice.headers, "/api/v1/timelines/home", ApiStatus.parseMany, "home");
    return home.find((status) => status.uri === monaPost.uri);
  });
  if (!onAliceHome.content.includes(monaText) || onAliceHome.account.uri !== mona.uri) {
    return fail("alice's home status does not match mona's post", onAliceHome);
  }
  console.log("ok Mastodon → tstodon: mona's post on alice's home timeline");

  await followRemote(mona, alice);
  console.log("ok Mastodon → tstodon: mona follows alice (Follow → Accept)");

  const aliceText = `alice to her followers ${Date.now()}`;
  const alicePost = await api(
    A,
    alice.headers,
    "/api/v1/statuses",
    ApiStatus.parse,
    "alice posts",
    {
      method: "POST",
      body: { status: aliceText, visibility: "public" },
    },
  );
  const onMonaHome = await waitFor("alice's post on mona's home timeline", async () => {
    const home = await api(
      MASTODON,
      mona.headers,
      "/api/v1/timelines/home",
      MastodonStatuses,
      "mona's home",
    );
    return home.find((status) => status.uri === alicePost.uri);
  });
  if (!onMonaHome.content.includes(aliceText)) {
    return fail("mona's home status does not match alice's post", onMonaHome);
  }
  console.log("ok tstodon → Mastodon: alice's post on mona's home timeline");
  console.log("PASS mastodon interop: follow both ways");
};

main().catch((error: unknown) => fail("unhandled", error));
