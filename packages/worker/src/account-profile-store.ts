import { schemaResult } from "@tstodon/core";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { nowIso } from "./clock";
import { jsonStringArray, runD1, type RepositoryError } from "./d1";
import {
  findAccountProfile as findAccountProfileSql,
  listAccountProfiles as listAccountProfilesSql,
  upsertAccountProfile as upsertAccountProfileSql,
} from "./generated/prisma/sql";
import { queryTyped, runTyped } from "./typed-sql";

export const ProfileFieldSchema = z.object({
  name: z.string(),
  value: z.string(),
});

export type ProfileField = z.infer<typeof ProfileFieldSchema>;

export type AccountProfile = Readonly<{
  note: string;
  fields: ReadonlyArray<ProfileField>;
  bot: boolean;
  discoverable: boolean;
  indexable: boolean;
  hideCollections: boolean;
  avatarObjectKey: string | null;
  avatarContentType: string | null;
  headerObjectKey: string | null;
  headerContentType: string | null;
}>;

export const EMPTY_ACCOUNT_PROFILE: AccountProfile = {
  note: "",
  fields: [],
  bot: false,
  discoverable: true,
  indexable: true,
  hideCollections: false,
  avatarObjectKey: null,
  avatarContentType: null,
  headerObjectKey: null,
  headerContentType: null,
};

const ProfileRowSchema = z.object({
  account_id: z.string().min(1),
  note: z.string(),
  fields_json: z.string(),
  bot: z.number(),
  discoverable: z.number(),
  indexable: z.number().optional(),
  hide_collections: z.number().optional(),
  avatar_object_key: z.string().nullable(),
  avatar_content_type: z.string().nullable(),
  header_object_key: z.string().nullable(),
  header_content_type: z.string().nullable(),
});

const parseProfileRow = schemaResult(ProfileRowSchema);
const parseFields = schemaResult(z.array(ProfileFieldSchema));

const profileFromRow = (row: z.infer<typeof ProfileRowSchema>): AccountProfile => {
  const fields = parseFields(JSON.parse(row.fields_json.length > 0 ? row.fields_json : "[]"));
  return {
    note: row.note,
    fields: fields.isOk() ? fields.value : [],
    bot: row.bot !== 0,
    discoverable: row.discoverable !== 0,
    indexable: (row.indexable ?? 1) !== 0,
    hideCollections: (row.hide_collections ?? 0) !== 0,
    avatarObjectKey: row.avatar_object_key,
    avatarContentType: row.avatar_content_type,
    headerObjectKey: row.header_object_key,
    headerContentType: row.header_content_type,
  };
};

export const findAccountProfile = async (
  db: D1Database,
  accountId: string,
): Promise<Result<AccountProfile, RepositoryError>> =>
  runD1(async () => {
    const rows = await queryTyped(db, findAccountProfileSql(accountId));
    const row = parseProfileRow(rows[0]);
    return row.isOk() ? profileFromRow(row.value) : { ...EMPTY_ACCOUNT_PROFILE };
  });

export const listAccountProfiles = async (
  db: D1Database,
  accountIds: ReadonlyArray<string>,
): Promise<Result<ReadonlyMap<string, AccountProfile>, RepositoryError>> => {
  const unique = [...new Set(accountIds.filter((id) => id.length > 0))];
  if (unique.length === 0) {
    return ok(new Map<string, AccountProfile>());
  }
  const queried = await runD1(async () =>
    queryTyped(db, listAccountProfilesSql(jsonStringArray(unique))),
  );
  if (queried.isErr()) {
    return err(queried.error);
  }
  const profiles = new Map<string, AccountProfile>();
  for (const raw of queried.value) {
    const row = parseProfileRow(raw);
    if (row.isOk()) {
      profiles.set(row.value.account_id, profileFromRow(row.value));
    }
  }
  return ok(profiles);
};

export const upsertAccountProfile = async (
  db: D1Database,
  accountId: string,
  profile: AccountProfile,
): Promise<Result<void, RepositoryError>> => {
  const written = await runD1(async () => {
    await runTyped(
      db,
      upsertAccountProfileSql(
        accountId,
        profile.note,
        JSON.stringify(profile.fields),
        profile.bot ? 1 : 0,
        profile.discoverable ? 1 : 0,
        profile.indexable ? 1 : 0,
        profile.hideCollections ? 1 : 0,
        profile.avatarObjectKey,
        profile.avatarContentType,
        profile.headerObjectKey,
        profile.headerContentType,
        nowIso(),
      ),
    );
  });
  return written.map(() => undefined);
};
