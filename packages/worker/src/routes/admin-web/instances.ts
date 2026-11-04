import { schemaResult, warmSchemas } from "@tstodon/core";
import type { Context } from "hono";
import type { Result } from "neverthrow";
import { z } from "zod";
import {
  changeDomainBlock,
  createDomainBlock,
  type CreateDomainBlockError,
  type DomainBlockSettings,
} from "../../admin-actions";
import {
  deleteDomainBlock,
  DomainBlockSeveritySchema,
  findDomainBlockByDomain,
  listDomainBlocks,
} from "../../admin-domain-block-store";
import { type DomainBlockForm, instancePage, instancesPage } from "../../admin-pages";
import { errorPage } from "../../auth-pages";
import { normalizeDomain } from "../../domain-block-store";
import { parseInstanceIdentity } from "../../runtime-config";
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

/** Mastodon's `/admin/instances` pages: the domains this server blocks, and how. */

/** Mastodon's `GET /admin/instances`; `?domain=` opens that domain's page. */
export const getAdminInstances = async (c: Context<{ Bindings: Env }, "/admin/instances">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const requested = normalizeDomain(c.req.query("domain") ?? "");
  if (requested.length > 0) {
    // Void copies the request's query onto a path-only redirect; an absolute
    // URL keeps `?domain=` off the domain's page.
    return c.redirect(
      new URL(`/admin/instances/${encodeURIComponent(requested)}`, c.req.url).toString(),
      303,
    );
  }
  const blocks = await listDomainBlocks(c.env.DB, 200, null);
  return blocks.isErr()
    ? serverError(c, blocks.error)
    : c.html(instancesPage(instanceName(c.env), blocks.value, noticeOf(c)));
};

const UNBLOCKED_FORM: DomainBlockForm = {
  severity: "silence",
  rejectMedia: false,
  rejectReports: false,
  obfuscate: false,
  privateComment: "",
  publicComment: "",
};

const checked = z
  .string()
  .optional()
  .transform((value) => value === "1");

const comment = z
  .string()
  .default("")
  .transform((value) => value.trim());

const DomainBlockFormSchema = z.object({
  do: z.union([z.literal("save"), z.literal("remove")]),
  severity: DomainBlockSeveritySchema.default("silence"),
  reject_media: checked,
  reject_reports: checked,
  obfuscate: checked,
  public_comment: comment,
  private_comment: comment,
});

const DOMAIN_BLOCK_ERRORS = {
  DomainRequired: "Enter a domain.",
  OwnDomain: "You cannot block this server's own domain.",
  AlreadyBlocked: "This domain is already blocked.",
} as const satisfies Record<Exclude<CreateDomainBlockError["kind"], "RepositoryError">, string>;

/** The domain in the path, or the page that answers instead. */
const instanceDomain = (
  c: SettingsContext,
  raw: string,
):
  | Readonly<{ kind: "Domain"; domain: string }>
  | Readonly<{ kind: "Answered"; response: Response }> => {
  const domain = normalizeDomain(raw);
  if (domain.length === 0) {
    return { kind: "Answered", response: notFound(c, "domain") };
  }
  return domain === raw
    ? { kind: "Domain", domain }
    : { kind: "Answered", response: c.redirect(`/admin/instances/${encodeURIComponent(domain)}`) };
};

/** Mastodon's `GET /admin/instances/:domain`: the domain's block, and the form to change it. */
export const getAdminInstance = async (
  c: Context<{ Bindings: Env }, "/admin/instances/:domain">,
) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const path = instanceDomain(c, c.req.param("domain"));
  if (path.kind === "Answered") {
    return path.response;
  }
  const block = await findDomainBlockByDomain(c.env.DB, path.domain);
  if (block.isErr()) {
    return serverError(c, block.error);
  }
  const form: DomainBlockForm = block.value
    ? {
        severity: block.value.severity,
        rejectMedia: block.value.reject_media !== 0,
        rejectReports: block.value.reject_reports !== 0,
        obfuscate: block.value.obfuscate !== 0,
        privateComment: block.value.private_comment ?? "",
        publicComment: block.value.public_comment ?? "",
      }
    : UNBLOCKED_FORM;
  return c.html(
    instancePage(
      instanceName(c.env),
      { domain: path.domain, blocked: block.value !== undefined, form },
      noticeOf(c),
    ),
  );
};

/** Create, change (`do=save`), or lift (`do=remove`) the domain's block. */
export const postAdminInstance = async (
  c: Context<{ Bindings: Env }, "/admin/instances/:domain">,
) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const path = instanceDomain(c, c.req.param("domain"));
  if (path.kind === "Answered") {
    return path.response;
  }
  const identity = parseInstanceIdentity(c.env);
  if (identity.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server is misconfigured."), 500);
  }
  const { domain } = path;
  const form = schemaResult(DomainBlockFormSchema)(await readFields(c));
  if (form.isErr()) {
    return badForm(c);
  }
  const existing = await findDomainBlockByDomain(c.env.DB, domain);
  if (existing.isErr()) {
    return serverError(c, existing.error);
  }
  if (form.value.do === "remove") {
    if (!existing.value) {
      return notFound(c, "domain block");
    }
    const removed = await deleteDomainBlock(c.env.DB, existing.value.id);
    return removed.isErr()
      ? serverError(c, removed.error)
      : c.redirect(withNotice("/admin/instances", "block_removed"), 303);
  }
  const settings: DomainBlockSettings = {
    severity: form.value.severity,
    rejectMedia: form.value.reject_media,
    rejectReports: form.value.reject_reports,
    obfuscate: form.value.obfuscate,
    privateComment: form.value.private_comment || null,
    publicComment: form.value.public_comment || null,
  };
  const saved: Result<unknown, CreateDomainBlockError> = existing.value
    ? await changeDomainBlock(c.env.DB, existing.value.id, settings)
    : await createDomainBlock(c.env.DB, identity.value.domain, domain, settings);
  if (saved.isOk()) {
    return c.redirect(withNotice(`/admin/instances/${domain}`, "block_saved"), 303);
  }
  if (saved.error.kind === "RepositoryError") {
    return serverError(c, saved.error);
  }
  return c.html(
    instancePage(
      instanceName(c.env),
      {
        domain,
        blocked: existing.value !== undefined,
        form: {
          severity: settings.severity,
          rejectMedia: settings.rejectMedia,
          rejectReports: settings.rejectReports,
          obfuscate: settings.obfuscate,
          privateComment: form.value.private_comment,
          publicComment: form.value.public_comment,
        },
      },
      { kind: "error", text: DOMAIN_BLOCK_ERRORS[saved.error.kind] },
    ),
    422,
  );
};

warmSchemas([DomainBlockFormSchema]);
