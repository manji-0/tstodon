/** Sweep area INT-13: custom emoji in a post, a display name, a profile and a poll, in both directions. */
import { A, signUp, type E2eUser } from "../lib.js";
import { png } from "./media.js";
import { z } from "zod";
import {
  Account,
  Anything,
  bothWays,
  call,
  type Cast,
  eventually,
  follow,
  mastodonRails,
  tstodonAdmin,
  onHome,
  post,
  resolveAccount,
  Status,
  step,
  StepFailure,
} from "./sweep.js";

/** tstodon's custom emoji, as `provision.rb` makes Mastodon's `:interop:`. */
const TSTODON_EMOJI = "tstodon_interop";

/** The custom emoji whose image the sweep changes, on tstodon and on Mastodon. */
const CHANGING = { tstodon: "tstodon_changing", mastodon: "interop_changing" } as const;

const AdminEmojis = z.array(z.looseObject({ id: z.string(), shortcode: z.string() }));

/**
 * Give tstodon's emoji `shortcode` a new image through the admin API, or,
 * with `create`, add it unless it is there.
 */
const tstodonEmojiImage = async (
  admin: E2eUser,
  shortcode: string,
  create: boolean,
): Promise<void> => {
  const emojiAdmin = await tstodonAdmin(admin);
  const found = (await call(emojiAdmin, "/api/v1/admin/custom_emojis", AdminEmojis)).find(
    (emoji) => emoji.shortcode === shortcode,
  );
  const form = new FormData();
  form.set("image", png([Date.now() % 256, 90, 160]), "emoji.png");
  if (found === undefined) {
    form.set("shortcode", shortcode);
    await call(emojiAdmin, "/api/v1/admin/custom_emojis", Anything, { method: "POST", form });
  } else if (!create) {
    await call(emojiAdmin, `/api/v1/admin/custom_emojis/${found.id}`, Anything, {
      method: "PATCH",
      form,
    });
  }
};

/**
 * Give Mastodon's local emoji `shortcode` a new image, as an admin's copy of
 * a remote emoji over it does (`CustomEmoji#copy!`), or, with `create`, add it
 * unless it is there. Mastodon has no client API for either.
 */
const mastodonEmojiImage = (shortcode: string, create: boolean): void => {
  mastodonRails(`
emoji = CustomEmoji.local.find_or_initialize_by(shortcode: '${shortcode}')
if ${create ? "emoji.new_record?" : "true"}
  File.open(Rails.public_path.join('${create ? "badge.png" : "web-push-icon_favourite.png"}')) do |image|
    emoji.image = image
    emoji.save!
  end
end
`);
};

const emojiUrl = (status: Status, shortcode: string): string | undefined =>
  status.emojis.find((emoji) => emoji.shortcode === shortcode)?.url;

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

  await bothWays(
    "an emoji whose image changes shows the new image on earlier posts",
    alice,
    mona,
    async (from, to) => {
      const shortcode = from === alice ? CHANGING.tstodon : CHANGING.mastodon;
      const setImage = async (create: boolean): Promise<void> => {
        if (from === alice) {
          await tstodonEmojiImage(admin, shortcode, create);
        } else {
          mastodonEmojiImage(shortcode, create);
        }
      };
      await setImage(true);
      const before = await post(from, { status: `before :${shortcode}: ${stamp}` });
      const earlier = await onHome(to, before.uri);
      const oldUrl = emojiUrl(earlier, shortcode);
      if (oldUrl === undefined) {
        throw new StepFailure(`the earlier copy's emojis are ${JSON.stringify(earlier.emojis)}`);
      }

      await setImage(false);
      const after = await post(from, { status: `after :${shortcode}: ${stamp}` });
      const newUrl = emojiUrl(await onHome(to, after.uri), shortcode);
      if (newUrl === undefined || newUrl === oldUrl) {
        throw new StepFailure(`the later copy shows ${String(newUrl)}, the earlier ${oldUrl}`);
      }
      let last = "";
      await eventually("the earlier post shows the new image", async () => {
        const now = await call(to, `/api/v1/statuses/${earlier.id}`, Status);
        last = String(emojiUrl(now, shortcode));
        return last === newUrl ? now : undefined;
      }).catch((error: unknown) => {
        throw new StepFailure(
          `${error instanceof Error ? error.message : String(error)}; it shows ${last}, the later post ${newUrl}`,
        );
      });
      await loadsAsImage(to, newUrl);
    },
  );
};
