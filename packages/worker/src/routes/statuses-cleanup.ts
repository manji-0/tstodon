import { warmSchemas } from "@tstodon/core";
import { type InteractionThreshold, StatusesCleanupPolicy } from "@tstodon/domain";
import type { Context } from "hono";
import { z } from "zod";
import { errorPage } from "../auth-pages";
import { readOptionalBody } from "../http";
import { type PageMessage, statusesCleanupPage } from "../settings-pages";
import { findStatusesCleanupPolicy, saveStatusesCleanupPolicy } from "../statuses-cleanup-store";
import { instanceName, type SettingsContext, settingsAccount } from "./account-settings";

/**
 * Mastodon's `/statuses_cleanup`: the account's automated post deletion
 * policy. The cron job in `src/statuses-cleanup.ts` applies it.
 */

/** Checkboxes post `1` when checked and nothing when not. */
const FormSchema = z.object({
  enabled: z.literal("1").optional(),
  min_status_age: z.string(),
  keep_pinned: z.literal("1").optional(),
  keep_direct: z.literal("1").optional(),
  keep_self_fav: z.literal("1").optional(),
  keep_self_bookmark: z.literal("1").optional(),
  keep_polls: z.literal("1").optional(),
  keep_media: z.literal("1").optional(),
  min_favs: z.string().trim().default(""),
  min_reblogs: z.string().trim().default(""),
});

/** An empty or zero field turns the rule off; anything else must be a whole number. */
const thresholdFromField = (field: string): InteractionThreshold | undefined => {
  if (field === "") {
    return { kind: "Off" };
  }
  if (!/^\d{1,9}$/.test(field)) {
    return undefined;
  }
  const count = Number(field);
  return count === 0 ? { kind: "Off" } : { kind: "AtLeast", count };
};

const render = async (
  c: SettingsContext,
  accountId: string,
  message?: PageMessage,
  status: 200 | 422 | 500 = 200,
) => {
  const policy = await findStatusesCleanupPolicy(c.env.DB, accountId);
  return policy.isErr()
    ? c.html(errorPage(instanceName(c.env), "The server could not read your settings."), 500)
    : c.html(statusesCleanupPage(instanceName(c.env), policy.value, message), status);
};

/** `GET /statuses_cleanup`. */
export const getStatusesCleanup = async (c: Context<{ Bindings: Env }, "/statuses_cleanup">) => {
  const signedIn = await settingsAccount(c);
  return signedIn.kind === "Answered" ? signedIn.response : render(c, signedIn.account.id);
};

/** `POST /statuses_cleanup`, as a form post. */
export const postStatusesCleanup = async (c: Context<{ Bindings: Env }, "/statuses_cleanup">) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const accountId = signedIn.account.id;
  const form = await readOptionalBody(c, FormSchema);
  const keepFavourites = form.isOk() ? thresholdFromField(form.value.min_favs) : undefined;
  const keepBoosts = form.isOk() ? thresholdFromField(form.value.min_reblogs) : undefined;
  const policy =
    form.isOk() && keepFavourites !== undefined && keepBoosts !== undefined
      ? StatusesCleanupPolicy.parse({
          kind: form.value.enabled === undefined ? "Disabled" : "Enabled",
          rules: {
            minAgeSeconds: Number(form.value.min_status_age),
            keepPinned: form.value.keep_pinned !== undefined,
            keepDirect: form.value.keep_direct !== undefined,
            keepSelfFavourited: form.value.keep_self_fav !== undefined,
            keepSelfBookmarked: form.value.keep_self_bookmark !== undefined,
            keepPolls: form.value.keep_polls !== undefined,
            keepMedia: form.value.keep_media !== undefined,
            keepFavourites,
            keepBoosts,
          },
        })
      : undefined;
  if (policy === undefined || policy.isErr()) {
    return render(
      c,
      accountId,
      {
        kind: "error",
        text: "Choose an age from the list, and leave the counts empty or enter whole numbers.",
      },
      422,
    );
  }
  const saved = await saveStatusesCleanupPolicy(c.env.DB, accountId, policy.value);
  return saved.isErr()
    ? render(
        c,
        accountId,
        { kind: "error", text: "The server could not save your settings. Try again." },
        500,
      )
    : render(c, accountId, { kind: "notice", text: "Changes saved." });
};

warmSchemas([FormSchema]);
