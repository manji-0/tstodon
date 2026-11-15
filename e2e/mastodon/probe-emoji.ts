/** Sweep area INT-13: custom emoji in a post, a display name, a profile and a poll, in both directions. */
import { A, signUp, type E2eUser } from "../lib.js";
import { png } from "./media.js";
import {
  Account,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  tstodonAdmin,
  onHome,
  post,
  resolveAccount,
  step,
  StepFailure,
} from "./sweep.js";

/** tstodon's custom emoji, as `provision.rb` makes Mastodon's `:interop:`. */
const TSTODON_EMOJI = "tstodon_interop";

const loadsAsImage = async (viewer: E2eUser, url: string): Promise<void> => {
  const response = await fetch(new URL(url, viewer.origin), { headers: viewer.headers });
  const type = response.headers.get("content-type") ?? "";
  await response.arrayBuffer();
  if (!response.ok || !type.startsWith("image/")) {
    throw new StepFailure(`the emoji ${url} answers ${response.status} ${type}`);
  }
};

export const emojiScenarios = async ({ stamp, mona }: Cast): Promise<void> => {
  const alice = await signUp(A, "emi");
  const admin = await signUp(A, "emoji_admin");
  const shortcodeOf = (user: E2eUser): string => (user === alice ? TSTODON_EMOJI : "interop");

  await bothWays("follow → accept", alice, mona, async (from, to) => {
    await follow(from, to);
  });

  await step("an admin adds a custom emoji on tstodon", async () => {
    const emojiAdmin = await tstodonAdmin(admin);
    const form = new FormData();
    form.set("shortcode", TSTODON_EMOJI);
    form.set("image", png([40, 120, 220]), "emoji.png");
    const response = await fetch(`${A}/api/v1/admin/custom_emojis`, {
      method: "POST",
      headers: emojiAdmin.headers,
      body: form,
    });
    const text = await response.text();
    // A second run against the same database finds the emoji there.
    if (!response.ok && !(response.status === 422 && /taken|exist/i.test(text))) {
      throw new StepFailure(`POST /api/v1/admin/custom_emojis → ${response.status} ${text}`);
    }
  });

  await bothWays("a custom emoji in a post arrives and loads", alice, mona, async (from, to) => {
    const shortcode = shortcodeOf(from);
    const sent = await post(from, { status: `emoji :${shortcode}: ${stamp}` });
    const copy = await onHome(to, sent.uri);
    const emoji = copy.emojis.find((entry) => entry.shortcode === shortcode);
    if (!emoji) {
      throw new StepFailure(`the copy's emojis are ${JSON.stringify(copy.emojis)}`);
    }
    await loadsAsImage(to, emoji.url);
  });

  await bothWays(
    "a custom emoji in a content warning and a poll option arrives",
    alice,
    mona,
    async (from, to) => {
      const shortcode = shortcodeOf(from);
      const sent = await post(from, {
        status: `emoji poll ${stamp}`,
        spoiler_text: `warning :${shortcode}:`,
        poll: { options: [`yes :${shortcode}:`, "no"], expires_in: 3600 },
      });
      const copy = await onHome(to, sent.uri);
      if (!copy.emojis.some((entry) => entry.shortcode === shortcode)) {
        throw new StepFailure(
          `the copy's emojis are ${JSON.stringify(copy.emojis)}, its poll's ${JSON.stringify(copy.poll?.["emojis"])}`,
        );
      }
    },
  );

  await bothWays(
    "a custom emoji in a display name and a bio arrives",
    alice,
    mona,
    async (from, to) => {
      const shortcode = shortcodeOf(from);
      const form = new FormData();
      form.set("display_name", `:${shortcode}: ${stamp}`);
      form.set("note", `bio :${shortcode}: ${stamp}`);
      await call(from, "/api/v1/accounts/update_credentials", Account, { method: "PATCH", form });
      const { id } = await resolveAccount(to, from);
      let last = "";
      const account = await eventually("the remote account has the emoji", async () => {
        const now = await call(to, `/api/v1/accounts/${id}`, Account);
        last = JSON.stringify({ display_name: now.display_name, emojis: now.emojis });
        return now.display_name.includes(`:${shortcode}: ${stamp}`) &&
          now.emojis.some((entry) => entry.shortcode === shortcode)
          ? now
          : undefined;
      }).catch((error: unknown) => {
        throw new StepFailure(
          `${error instanceof Error ? error.message : String(error)}; saw ${last}`,
        );
      });
      await loadsAsImage(
        to,
        account.emojis.find((entry) => entry.shortcode === shortcode)?.url ?? "",
      );
    },
  );
};
