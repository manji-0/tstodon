/**
 * Sweep area INT-3: signed fetches of actors, notes and collections. The
 * signed steps run in every mode; the "refused unsigned" steps run for a
 * server that is in secure mode (`TSTODON_AUTHORIZED_FETCH=true
 * start-tstodon.sh`, `MASTODON_AUTHORIZED_FETCH=true bootstrap.sh`) and are
 * skipped otherwise.
 */
import { z } from "zod";
import { A, signUp, type E2eUser } from "../lib.js";
import {
  Account,
  call,
  type Cast,
  eventually,
  follow,
  post,
  resolveAccount,
  resolveStatus,
  skip,
  step,
  StepFailure,
} from "./sweep.js";

const ACTIVITY_JSON = "application/activity+json";

const CountedAccount = Account.extend({ statuses_count: z.number() });
const ActorDocument = z.looseObject({ id: z.string(), publicKey: z.unknown() });

/** An ActivityPub GET with no signature. */
const unsigned = (url: string): Promise<Response> =>
  fetch(url, { headers: { Accept: ACTIVITY_JSON }, redirect: "manual" });

const expectStatus = async (url: string, expected: number): Promise<void> => {
  const response = await unsigned(url);
  await response.arrayBuffer();
  if (response.status !== expected) {
    throw new StepFailure(`unsigned GET ${url} → ${response.status}, expected ${expected}`);
  }
};

/** Whether tstodon serves an unsigned request the restricted actor document. */
const tstodonIsSecure = async (user: E2eUser): Promise<boolean> => {
  const response = await unsigned(user.uri);
  const actor = z.looseObject({ followers: z.string().optional() }).parse(await response.json());
  return actor.followers === undefined;
};

const mastodonIsSecure = async (user: E2eUser): Promise<boolean> => {
  const response = await unsigned(user.uri);
  await response.arrayBuffer();
  return response.status === 401;
};

export const authorizedFetchScenarios = async ({ stamp, carol, dana }: Cast): Promise<void> => {
  const nora = await signUp(A, "nora");
  const fan = await signUp(A, "nils");
  const viewer = await signUp(A, "vera");
  const tstodonSecure = await tstodonIsSecure(nora);
  const mastodonSecure = await mastodonIsSecure(carol);
  console.log(
    `secure mode: tstodon ${tstodonSecure ? "on" : "off"}, Mastodon ${mastodonSecure ? "on" : "off"}`,
  );

  const form = new FormData();
  form.set("display_name", `Nora ${stamp}`);
  await call(nora, "/api/v1/accounts/update_credentials", Account, { method: "PATCH", form });
  const first = await post(nora, { status: `nora one ${stamp}` });
  await post(nora, { status: `nora two ${stamp}` });
  await follow(fan, nora);

  await step(
    "Mastodon fetches a tstodon actor with its profile and collection counts",
    async () => {
      const resolved = await resolveAccount(dana, nora);
      const account = await eventually("the account has the profile and the counts", async () => {
        const now = await call(dana, `/api/v1/accounts/${resolved.id}`, CountedAccount);
        return now.display_name === `Nora ${stamp}` ? now : undefined;
      }).catch(async (error: unknown) => {
        const now = await call(dana, `/api/v1/accounts/${resolved.id}`, CountedAccount);
        throw new StepFailure(
          `${error instanceof Error ? error.message : String(error)}; display_name is ${JSON.stringify(now.display_name)}`,
        );
      });
      if (account.statuses_count !== 2 || account.followers_count !== 1) {
        throw new StepFailure(
          `Mastodon read ${account.statuses_count} statuses and ${account.followers_count} followers, not 2 and 1`,
        );
      }
    },
  );

  await step("Mastodon fetches a tstodon note it never saw", async () => {
    await resolveStatus(dana, first.uri);
  });

  await step("tstodon fetches a Mastodon actor and a note it never saw", async () => {
    const sent = await post(carol, { status: `carol for a signed fetch ${stamp}` });
    await resolveAccount(viewer, carol);
    await resolveStatus(viewer, sent.uri);
  });

  const tstodonRefusals =
    "tstodon refuses unsigned fetches of an actor's profile, notes and collections";
  if (tstodonSecure) {
    await step(tstodonRefusals, async () => {
      const response = await unsigned(nora.uri);
      const text = await response.text();
      const actor = ActorDocument.safeParse(JSON.parse(text));
      if (response.status !== 200 || !actor.success || actor.data.publicKey === undefined) {
        throw new StepFailure(
          `unsigned GET ${nora.uri} → ${response.status} ${text.slice(0, 200)}`,
        );
      }
      if (text.includes(`Nora ${stamp}`)) {
        throw new StepFailure("the unsigned actor document carries the display name");
      }
      await expectStatus(first.uri, 401);
      for (const collection of ["outbox", "followers", "following"]) {
        await expectStatus(`${nora.uri}/${collection}`, 401);
      }
      await expectStatus(`${nora.uri}/outbox?page=true`, 401);
    });
  } else {
    skip(tstodonRefusals, "tstodon is not in secure mode (TSTODON_AUTHORIZED_FETCH=true)");
  }

  const mastodonRefusals = "Mastodon refuses unsigned fetches of an actor and a note";
  if (mastodonSecure) {
    await step(mastodonRefusals, async () => {
      const sent = await post(carol, { status: `carol behind secure mode ${stamp}` });
      await expectStatus(carol.uri, 401);
      await expectStatus(sent.uri, 401);
    });
  } else {
    skip(mastodonRefusals, "Mastodon is not in secure mode (MASTODON_AUTHORIZED_FETCH=true)");
  }
};
