import type { ApiAdminIpBlockJSON } from "@tstodon/api";
import { IpBlock, IpBlockSeverity, type IpBlockValue, IpRange } from "@tstodon/domain";
import type { Context } from "hono";
import { z } from "zod";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  queryAdminLimit,
  queryCursor,
  readBody,
  requireAdmin,
  setPaginationLinks,
} from "../../http";
import { forgetIpBlocks } from "../../ip-access";
import {
  deleteIpBlock,
  findIpBlockById,
  findIpBlockByRange,
  insertIpBlock,
  type IpBlockInput,
  listIpBlockPage,
  updateIpBlock,
} from "../../ip-block-store";
import { validation } from "./shared";

/**
 * `/api/v1/admin/ip_blocks` (Mastodon's `Api::V1::Admin::IpBlocksController`).
 * Changing a block drops this isolate's cached block list at once; other
 * isolates see the change within a minute (`server/ip-access.ts`).
 */

const ipBlockDocument = (block: IpBlockValue): ApiAdminIpBlockJSON => ({
  id: block.id,
  ip: block.range,
  severity: IpBlockSeverity.toName(block.severity),
  comment: block.comment,
  created_at: block.createdAt,
  expires_at: block.expiry.kind === "Expires" ? block.expiry.at : null,
});

const IpBlockBodySchema = z.object({
  ip: z.string().optional(),
  severity: z.string().optional(),
  comment: z.string().nullable().optional(),
  expires_in: z.union([z.number(), z.string()]).nullable().optional(),
});

type IpBlockBody = z.infer<typeof IpBlockBodySchema>;

const notFound = (c: Context<{ Bindings: Env }>) =>
  c.json({ error: "Record not found", kind: "NotFound" }, 404);

/** `expires_in` seconds: absent keeps `current`, blank or `null` makes the block permanent. */
const expiryFrom = (
  raw: IpBlockBody["expires_in"],
  current: IpBlockValue["expiry"],
): IpBlockValue["expiry"] | "invalid" => {
  if (raw === undefined) {
    return current;
  }
  if (raw === null || (typeof raw === "string" && raw.trim().length === 0)) {
    return { kind: "Permanent" };
  }
  const seconds = typeof raw === "number" ? raw : Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "invalid";
  }
  return IpBlock.expiryIn(seconds, Date.now());
};

/**
 * The block a body describes on top of `current` (an update) or nothing (a
 * create, where `ip` and `severity` are required). The answer is the input
 * or Mastodon's validation message.
 */
const blockInput = (
  body: IpBlockBody,
  current: IpBlockValue | undefined,
): IpBlockInput | string => {
  const rawIp = body.ip?.trim();
  if (current === undefined && !rawIp) {
    return "Validation failed: Ip can't be blank";
  }
  const range = rawIp ? IpRange.parse(rawIp) : undefined;
  if (range !== undefined && range.isErr()) {
    return "Validation failed: Ip is invalid";
  }
  const rawSeverity = body.severity?.trim();
  if (current === undefined && !rawSeverity) {
    return "Validation failed: Severity can't be blank";
  }
  const severity = rawSeverity ? IpBlockSeverity.fromName(rawSeverity) : current?.severity;
  if (severity === undefined) {
    return "Validation failed: Severity is not included in the list";
  }
  const expiry = expiryFrom(body.expires_in, current?.expiry ?? { kind: "Permanent" });
  if (expiry === "invalid") {
    return "Validation failed: Expires in is invalid";
  }
  const resolvedRange = range === undefined ? current?.range : range.unwrapOr(undefined);
  if (resolvedRange === undefined) {
    return "Validation failed: Ip can't be blank";
  }
  return {
    range: resolvedRange,
    severity,
    comment: body.comment === undefined ? (current?.comment ?? "") : (body.comment ?? "").trim(),
    expiry,
  };
};

/** Another block already holds this range. */
const rangeTaken = async (
  db: D1Database,
  input: IpBlockInput,
  selfId: string | undefined,
): Promise<boolean> => {
  const existing = await findIpBlockByRange(db, input.range);
  if (existing.isErr()) {
    return true;
  }
  return existing.value !== undefined && existing.value.id !== selfId;
};

export const getV1AdminIpBlocks = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/ip_blocks">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const limit = queryAdminLimit(c.req.query("limit"));
  const blocks = await listIpBlockPage(c.env.DB, queryCursor(c), limit);
  if (blocks.isErr()) {
    return jsonRepositoryError(c, blocks.error.message);
  }
  setPaginationLinks(
    c,
    blocks.value.map((block) => block.id),
    limit,
  );
  return c.json(blocks.value.map(ipBlockDocument));
};

export const getV1AdminIpBlocksById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/ip_blocks/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const block = await findIpBlockById(c.env.DB, c.req.param("id") ?? "");
  if (block.isErr()) {
    return jsonRepositoryError(c, block.error.message);
  }
  return block.value ? c.json(ipBlockDocument(block.value)) : notFound(c);
};

export const postV1AdminIpBlocks = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/ip_blocks">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const body = await readBody(c, IpBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const input = blockInput(body.value, undefined);
  if (typeof input === "string") {
    return validation(c, input);
  }
  if (await rangeTaken(c.env.DB, input, undefined)) {
    return validation(c, "Validation failed: Ip has already been taken");
  }
  const created = await insertIpBlock(c.env.DB, input);
  forgetIpBlocks();
  if (created.isErr()) {
    return jsonRepositoryError(c, created.error.message);
  }
  return created.value ? c.json(ipBlockDocument(created.value)) : notFound(c);
};

export const putV1AdminIpBlocksById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/ip_blocks/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const id = c.req.param("id") ?? "";
  const current = await findIpBlockById(c.env.DB, id);
  if (current.isErr()) {
    return jsonRepositoryError(c, current.error.message);
  }
  if (!current.value) {
    return notFound(c);
  }
  const body = await readBody(c, IpBlockBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const input = blockInput(body.value, current.value);
  if (typeof input === "string") {
    return validation(c, input);
  }
  if (await rangeTaken(c.env.DB, input, id)) {
    return validation(c, "Validation failed: Ip has already been taken");
  }
  const updated = await updateIpBlock(c.env.DB, id, input);
  forgetIpBlocks();
  if (updated.isErr()) {
    return jsonRepositoryError(c, updated.error.message);
  }
  return updated.value ? c.json(ipBlockDocument(updated.value)) : notFound(c);
};

export const deleteV1AdminIpBlocksById = async (
  c: Context<{ Bindings: Env }, "/api/v1/admin/ip_blocks/:id">,
) => {
  const admin = await requireAdmin(c);
  if (admin.isErr()) {
    return jsonAuthError(c, admin.error);
  }
  const deleted = await deleteIpBlock(c.env.DB, c.req.param("id") ?? "");
  forgetIpBlocks();
  if (deleted.isErr()) {
    return jsonRepositoryError(c, deleted.error.message);
  }
  return deleted.value ? c.json({}) : notFound(c);
};
