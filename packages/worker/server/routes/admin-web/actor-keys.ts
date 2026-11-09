import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import {
  ROTATE_ACTOR_KEYS_PAGE,
  rotateInstanceActorKey,
  startRotateAllActorKeys,
} from "../../actor-key-rotation";
import { actorKeysPage, confirmPage } from "../../admin-pages";
import { errorPage } from "../../auth-pages";
import { instanceActorKeyDates } from "../../instance-actor";
import { pageRedirect } from "../../page-redirect";
import { instanceName } from "../account-settings";
import { adminSession, badForm, noticeOf, readFields, serverError, withNotice } from "./shared";

/**
 * The signing keys page (OPS-8, no Mastodon counterpart): rotate the instance
 * actor's key, or start the bulk rotation of every local key.
 */

const PATH = "/admin/actor_keys";

const ActorKeysFormSchema = z.object({
  do: z.union([z.literal("rotate_instance"), z.literal("rotate_all")]),
  confirmed: z.string().optional(),
});

export const getAdminActorKeys = async (c: Context<{ Bindings: Env }, "/admin/actor_keys">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const dates = await instanceActorKeyDates(c.env.DB);
  if (dates.isErr()) {
    return serverError(c, dates.error);
  }
  return c.html(
    actorKeysPage(
      instanceName(c.env),
      { instanceActor: dates.value, pageSize: ROTATE_ACTOR_KEYS_PAGE },
      noticeOf(c),
    ),
  );
};

export const postAdminActorKeys = async (c: Context<{ Bindings: Env }, "/admin/actor_keys">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const form = schemaResult(ActorKeysFormSchema)(await readFields(c));
  if (form.isErr()) {
    return badForm(c);
  }
  const all = form.value.do === "rotate_all";
  if (form.value.confirmed !== "1") {
    return c.html(
      confirmPage(instanceName(c.env), {
        title: all ? "Rotate every signing key?" : "Rotate the instance actor's key?",
        text: all
          ? "Every local account and the instance actor get a new key pair, and the old keys stop working. Each account's followers' servers are sent its new key; other servers fetch it when a signature fails to verify."
          : "The instance actor gets a new key pair and the old one stops working. Other servers fetch the new key when a signature fails to verify.",
        action: PATH,
        fields: { do: form.value.do },
        confirmLabel: all ? "Rotate every key" : "Rotate the key",
        cancelHref: PATH,
      }),
    );
  }
  console.log(
    JSON.stringify({
      kind: "ActorKeyRotationRequested",
      target: all ? "All" : "InstanceActor",
      adminAccountId: admin.account.id,
    }),
  );
  if (!all) {
    const rotated = await rotateInstanceActorKey(c.env.DB);
    return rotated.isErr()
      ? serverError(c, rotated.error)
      : pageRedirect(c, withNotice(PATH, "instance_key_rotated"), 303);
  }
  const started = await startRotateAllActorKeys(c.env);
  if (started.isErr()) {
    return c.html(
      errorPage(
        instanceName(c.env),
        `The rotation could not be queued: ${started.error.message}. Try again.`,
      ),
      503,
    );
  }
  return pageRedirect(c, withNotice(PATH, "key_rotation_started"), 303);
};

warmSchemas([ActorKeysFormSchema]);
