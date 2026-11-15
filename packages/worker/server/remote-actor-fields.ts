import { schemaResult } from "@tstodon/core";
import type { RemoteActorProfile } from "@tstodon/domain";
import { z } from "zod";

/** `ActivityPub::ProcessAccountService::MAX_PROFILE_FIELDS`. */
const MAX_PROFILE_FIELDS = 50;

/** `Account::Field::MAX_CHARACTERS_COMPAT`: what Mastodon keeps of a remote field's name and value. */
const MAX_FIELD_CHARACTERS = 2047;

const parseTyped = schemaResult(z.object({ type: z.unknown() }));
const parseField = schemaResult(z.object({ name: z.string(), value: z.string() }));

/** Trimmed, then cut at Mastodon's limit, which counts characters and not UTF-16 units. */
const kept = (text: string): string =>
  Array.from(text.trim()).slice(0, MAX_FIELD_CHARACTERS).join("");

/**
 * The profile fields of an actor document: the `PropertyValue` objects of its
 * `attachment`, as Mastodon's `ProcessAccountService#property_values` and
 * `Account::Field` read them. The first fifty are taken, and one whose name
 * or value is not text is then left out. The value is the actor's HTML, kept
 * as sent and sanitised where it is rendered.
 */
export const actorFields = (attachment: unknown): RemoteActorProfile["fields"] => {
  const entries: ReadonlyArray<unknown> = Array.isArray(attachment) ? attachment : [];
  return entries
    .filter((entry) => {
      const typed = parseTyped(entry);
      return typed.isOk() && typed.value.type === "PropertyValue";
    })
    .slice(0, MAX_PROFILE_FIELDS)
    .flatMap((entry) => {
      const field = parseField(entry);
      return field.isOk() ? [{ name: kept(field.value.name), value: kept(field.value.value) }] : [];
    });
};
