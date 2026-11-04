import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import { z } from "zod";
import { type EmailDomainBlockEntry, emailDomainBlocksPage } from "../../admin-content-pages";
import { normalizeDomain } from "../../domain-block-store";
import { pageRedirect } from "../../page-redirect";
import {
  deleteEmailDomainBlock,
  emailDomainHistory,
  insertEmailDomainBlock,
  listEmailDomainBlocks,
} from "../../registration-block-store";
import type { PageMessage } from "../../settings-pages";
import { instanceName, type SettingsContext } from "../account-settings";
import {
  adminSession,
  badForm,
  notFound,
  noticeOf,
  readFields,
  serverError,
  withNotice,
} from "./shared";

/** Mastodon's `/admin/email_domain_blocks` page: the email domains nobody can sign up with. */

const BLOCKS_PER_PAGE = 200;

const EmailBlockFormSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("add"), domain: z.string().default("") }),
  z.object({ do: z.literal("remove"), id: z.string().min(1) }),
]);

const renderBlocks = async (
  c: SettingsContext,
  domain: string,
  message: PageMessage | undefined,
  status: 200 | 422 = 200,
) => {
  const blocks = await listEmailDomainBlocks(c.env.DB, BLOCKS_PER_PAGE);
  if (blocks.isErr()) {
    return serverError(c, blocks.error);
  }
  const entries: EmailDomainBlockEntry[] = [];
  for (const block of blocks.value) {
    const history = await emailDomainHistory(c.env.DB, block.domain);
    entries.push({
      id: block.id,
      domain: block.domain,
      createdAt: block.createdAt,
      recentAccounts: history.isOk()
        ? history.value.reduce((sum, day) => sum + Number(day.accounts), 0)
        : 0,
    });
  }
  return c.html(
    emailDomainBlocksPage(instanceName(c.env), { blocks: entries, domain }, message),
    status,
  );
};

/** Mastodon's `GET /admin/email_domain_blocks`. */
export const getAdminEmailDomainBlocks = async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  return admin.kind === "Answered" ? admin.response : renderBlocks(c, "", noticeOf(c));
};

/** Block (`do=add`) or unblock (`do=remove`) an email domain. */
export const postAdminEmailDomainBlocks = async (c: Context<{ Bindings: Env }>) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const form = schemaResult(EmailBlockFormSchema)(await readFields(c));
  if (form.isErr()) {
    return badForm(c);
  }
  if (form.value.do === "remove") {
    const removed = await deleteEmailDomainBlock(c.env.DB, form.value.id);
    if (removed.isErr()) {
      return serverError(c, removed.error);
    }
    return removed.value
      ? pageRedirect(c, withNotice("/admin/email_domain_blocks", "email_block_removed"), 303)
      : notFound(c, "email domain block");
  }
  const domain = normalizeDomain(form.value.domain);
  if (domain.length === 0) {
    return renderBlocks(c, form.value.domain, { kind: "error", text: "Enter a domain." }, 422);
  }
  const blocked = await insertEmailDomainBlock(c.env.DB, domain);
  // The domain column is unique: a failed insert is a domain that is blocked already.
  return blocked.isOk()
    ? pageRedirect(c, withNotice("/admin/email_domain_blocks", "email_block_added"), 303)
    : renderBlocks(c, domain, { kind: "error", text: "This domain is already blocked." }, 422);
};

warmSchemas([EmailBlockFormSchema]);
