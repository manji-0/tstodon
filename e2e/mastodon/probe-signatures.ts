/**
 * Sweep area FED-13: tstodon Linked-Data-signs the activities Mastodon signs.
 * Mastodon reads a signed activity in its JSON-LD compacted form, so a signed
 * post must read there as sent; and a signature must verify with the key
 * Mastodon resolves for the actor, which is what lets a third server take the
 * activity forwarded. With one Mastodon a forward cannot be seen, so the
 * second step runs Mastodon's own check (`LinkedDataSignature#verify_actor!`)
 * on the `Delete` tstodon delivered, which tstodon signs in every mode.
 */
import { z } from "zod";
import { A, signUp } from "../lib.js";
import {
  Anything,
  call,
  type Cast,
  eventually,
  follow,
  mastodonRails,
  onHome,
  post,
  Statuses,
  step,
  StepFailure,
  tstodonSql,
} from "./sweep.js";

const StoredActivity = z.object({ payload_json: z.string() });

export const signatureScenarios = async ({ stamp, mona }: Cast): Promise<void> => {
  const sam = await signUp(A, "sam");
  await follow(mona, sam);

  await step("a sensitive public post reads on Mastodon as sent", async () => {
    const sent = await post(sam, { status: `signed ${stamp}`, sensitive: true });
    await onHome(mona, sent.uri, (status) => status.sensitive);
  });

  await step("Mastodon verifies tstodon's Linked Data signature on a Delete", async () => {
    const sent = await post(sam, { status: `to delete ${stamp}` });
    await onHome(mona, sent.uri);
    await call(sam, `/api/v1/statuses/${sent.id}`, Anything, { method: "DELETE" });
    await eventually("the post leaves mona's home", async () => {
      const home = await call(mona, "/api/v1/timelines/home?limit=40", Statuses);
      return home.some((status) => status.uri === sent.uri) ? undefined : true;
    });
    const [row] = tstodonSql(
      `SELECT payload_json FROM outbound_activities WHERE kind = 'Delete' AND json_extract(payload_json, '$.object.id') = '${sent.uri}'`,
    );
    const stored = StoredActivity.safeParse(row);
    if (!stored.success) {
      throw new StepFailure(`tstodon stored no Delete of ${sent.uri}`);
    }
    const body = Buffer.from(stored.data.payload_json).toString("base64");
    const out = mastodonRails(`
      json = JSON.parse(Base64.decode64('${body}'))
      compacted = Object.new.extend(JsonLdHelper).compact(json)
      actor = ActivityPub::LinkedDataSignature.new(compacted).verify_actor!
      puts "VERIFIED #{actor&.uri}"
    `);
    if (!out.includes(`VERIFIED ${sam.uri}`)) {
      throw new StepFailure(`verify_actor! on tstodon's Delete: ${out.trim().slice(-300)}`);
    }
  });

  await step(
    "tstodon accepts the RFC 9421 delivery Mastodon double-knocks with (FED-9)",
    async () => {
      // Mastodon sends RFC 9421 only once a draft-cavage request is answered
      // 400 or 401, which tstodon does not do to a good signature, and no
      // setting changes that. So the step runs that second knock itself:
      // `DeliveryWorker#build_request`, then `Request#perform_rfc9421_signed_request`.
      const target = await signUp(A, "knock");
      const out = mastodonRails(`
      account = Account.find_local(${JSON.stringify(mona.username)})
      body = Oj.dump({
        '@context' => 'https://www.w3.org/ns/activitystreams',
        'id' => ${JSON.stringify(`${mona.uri}#follows/rfc9421-${stamp}`)},
        'type' => 'Follow',
        'actor' => ActivityPub::TagManager.instance.uri_for(account),
        'object' => ${JSON.stringify(target.uri)},
      })
      request = Request.new(:post, ${JSON.stringify(new URL("/inbox", target.uri).href)}, body: body)
      request.on_behalf_of(account)
      request.add_headers(ActivityPub::DeliveryWorker::HEADERS)
      response = request.send(:perform_rfc9421_signed_request)
      puts "STATUS #{response.code}"
    `);
      if (!out.includes("STATUS 202")) {
        throw new StepFailure(`tstodon answered the RFC 9421 Follow: ${out.trim().slice(-300)}`);
      }
      await eventually("tstodon records mona's follow", async () =>
        tstodonSql(
          `SELECT 1 FROM remote_follows WHERE target_account_id = '${target.id}' AND remote_actor_uri = '${mona.uri}'`,
        ).length > 0
          ? true
          : undefined,
      );
    },
  );
};
