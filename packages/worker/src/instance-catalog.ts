import { schemaResult, type ValidationError } from "@tstodon/core";
import {
  Announcement,
  CustomEmoji,
  InstanceRule,
  type Announcement as AnnouncementValue,
  type CustomEmoji as CustomEmojiValue,
  type InstanceRule as InstanceRuleValue,
} from "@tstodon/domain";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const optionalEnvString = (env: Env, key: string): string => {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
};

const ruleInputSchema = z.union([
  z.string().trim().min(1),
  z.object({
    id: z.string().trim().min(1).optional(),
    text: z.string().trim().min(1),
  }),
]);

const rulesJsonSchema = z.array(ruleInputSchema);
const parseRulesJson = schemaResult(rulesJsonSchema);

const emojiInputSchema = z.object({
  shortcode: z.string().trim().min(1),
  url: z.url(),
  static_url: z.url().optional(),
  staticUrl: z.url().optional(),
  visible_in_picker: z.boolean().optional(),
  visibleInPicker: z.boolean().optional(),
  category: z.string().trim().min(1).optional(),
});
const emojisJsonSchema = z.array(emojiInputSchema);
const parseEmojisJson = schemaResult(emojisJsonSchema);

const announcementInputSchema = z.object({
  id: z.string().trim().min(1),
  content: z.string().trim().min(1),
  published_at: z.iso.datetime().optional(),
  publishedAt: z.iso.datetime().optional(),
  updated_at: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
  starts_at: z.iso.datetime().nullable().optional(),
  startsAt: z.iso.datetime().nullable().optional(),
  ends_at: z.iso.datetime().nullable().optional(),
  endsAt: z.iso.datetime().nullable().optional(),
  all_day: z.boolean().optional(),
  allDay: z.boolean().optional(),
});
const announcementsJsonSchema = z.array(announcementInputSchema);
const parseAnnouncementsJson = schemaResult(announcementsJsonSchema);

const validationError = (message: string): ValidationError => ({
  kind: "ValidationError",
  issues: [{ message }],
});

export const parseInstanceRules = (
  env: Env,
): Result<ReadonlyArray<InstanceRuleValue>, ValidationError> => {
  const raw = optionalEnvString(env, "INSTANCE_RULES");
  if (raw.length === 0) {
    return ok([]);
  }
  if (raw.startsWith("[")) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return err(validationError("INSTANCE_RULES must be valid JSON"));
    }
    const parsed = parseRulesJson(json);
    if (parsed.isErr()) {
      return err(validationError("INSTANCE_RULES must be a JSON array of rules"));
    }
    const rules: InstanceRuleValue[] = [];
    for (const [index, entry] of parsed.value.entries()) {
      const text = typeof entry === "string" ? entry : entry.text;
      const id = typeof entry === "string" ? String(index + 1) : (entry.id ?? String(index + 1));
      const rule = InstanceRule.parse({ kind: "InstanceRule", id, text });
      if (rule.isErr()) {
        return err(rule.error);
      }
      rules.push(rule.value);
    }
    return ok(rules);
  }
  const rules = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((text, index) => InstanceRule.fromText(text, index));
  return ok(rules);
};

export const parseCustomEmojis = (
  env: Env,
): Result<ReadonlyArray<CustomEmojiValue>, ValidationError> => {
  const raw = optionalEnvString(env, "INSTANCE_CUSTOM_EMOJIS");
  if (raw.length === 0) {
    return ok([]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err(validationError("INSTANCE_CUSTOM_EMOJIS must be valid JSON"));
  }
  const parsed = parseEmojisJson(json);
  if (parsed.isErr()) {
    return err(validationError("INSTANCE_CUSTOM_EMOJIS must be a JSON array of emoji objects"));
  }
  const emojis: CustomEmojiValue[] = [];
  for (const entry of parsed.value) {
    const emoji = CustomEmoji.parse({
      kind: "CustomEmoji",
      shortcode: entry.shortcode,
      url: entry.url,
      staticUrl: entry.staticUrl ?? entry.static_url ?? entry.url,
      visibleInPicker: entry.visibleInPicker ?? entry.visible_in_picker ?? true,
      ...(entry.category ? { category: entry.category } : {}),
    });
    if (emoji.isErr()) {
      return err(emoji.error);
    }
    emojis.push(emoji.value);
  }
  return ok(emojis);
};

export const parseAnnouncements = (
  env: Env,
): Result<ReadonlyArray<AnnouncementValue>, ValidationError> => {
  const raw = optionalEnvString(env, "INSTANCE_ANNOUNCEMENTS");
  if (raw.length === 0) {
    return ok([]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err(validationError("INSTANCE_ANNOUNCEMENTS must be valid JSON"));
  }
  const parsed = parseAnnouncementsJson(json);
  if (parsed.isErr()) {
    return err(validationError("INSTANCE_ANNOUNCEMENTS must be a JSON array of announcements"));
  }
  const announcements: AnnouncementValue[] = [];
  for (const entry of parsed.value) {
    const publishedAt = entry.publishedAt ?? entry.published_at ?? "1970-01-01T00:00:00.000Z";
    const updatedAt = entry.updatedAt ?? entry.updated_at ?? publishedAt;
    const announcement = Announcement.parse({
      kind: "Announcement",
      id: entry.id,
      content: entry.content,
      publishedAt,
      updatedAt,
      startsAt: entry.startsAt ?? entry.starts_at ?? null,
      endsAt: entry.endsAt ?? entry.ends_at ?? null,
      allDay: entry.allDay ?? entry.all_day ?? false,
    });
    if (announcement.isErr()) {
      return err(announcement.error);
    }
    announcements.push(announcement.value);
  }
  return ok(announcements);
};

export const mastodonCustomEmojiDocument = (
  emoji: CustomEmojiValue,
): Readonly<{
  shortcode: string;
  url: string;
  static_url: string;
  visible_in_picker: boolean;
  category?: string;
}> => ({
  shortcode: emoji.shortcode,
  url: emoji.url,
  static_url: emoji.staticUrl,
  visible_in_picker: emoji.visibleInPicker,
  ...(emoji.category ? { category: emoji.category } : {}),
});

export const mastodonAnnouncementDocument = (
  announcement: AnnouncementValue,
  contentHtml: string,
): Readonly<{
  id: string;
  content: string;
  starts_at: string | null;
  ends_at: string | null;
  all_day: boolean;
  published_at: string;
  updated_at: string;
  read: boolean;
  mentions: [];
  statuses: [];
  tags: [];
  emojis: [];
  reactions: [];
}> => ({
  id: announcement.id,
  content: contentHtml,
  starts_at: announcement.startsAt === null ? null : `${announcement.startsAt}`,
  ends_at: announcement.endsAt === null ? null : `${announcement.endsAt}`,
  all_day: announcement.allDay,
  published_at: `${announcement.publishedAt}`,
  updated_at: `${announcement.updatedAt}`,
  read: false,
  mentions: [],
  statuses: [],
  tags: [],
  emojis: [],
  reactions: [],
});

export const mastodonInstanceRuleDocument = (
  rule: InstanceRuleValue,
): Readonly<{ id: string; text: string }> => ({
  id: rule.id,
  text: rule.text,
});
