import { Hostname } from "@tstodon/domain";
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
import {
  clearDeliveryDomainHealth,
  findDeliveryDomainHealth,
  listDeliveryDomainHealth,
  logDeliveryDomainChange,
} from "../../delivery-domain-health-store";
import { errorPage } from "../../auth-pages";
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
import { pageRedirect } from "../../page-redirect";

/** Mastodon's `/admin/instances` pages: the domains this server blocks, and how. */

/** Mastodon's `GET /admin/instances`; `?domain=` opens that domain's page. */
export const getAdminInstances = async (c: Context<{ Bindings: Env }, "/admin/instances">) => {
  const admin = await adminSession(c);
  if (admin.kind === "Answered") {
    return admin.response;
  }
  const requested = Hostname.fromInput(c.req.query("domain") ?? "");
  if (requested !== undefined) {
    return pageRedirect(c, `/admin/instances/${encodeURIComponent(requested)}`, 303);
  }
  const blocks = await listDomainBlocks(c.env.DB, 200, null);
  if (blocks.isErr()) {
    return serverError(c, blocks.error);
  }
  const health = await listDeliveryDomainHealth(c.env.DB);
  return health.isErr()
    ? serverError(c, health.error)
    : c.html(instancesPage(instanceName(c.env), blocks.value, noticeOf(c), health.value));
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
  do: z.union([z.literal("save"), z.literal("remove"), z.literal("mark_available")]),
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
  | Readonly<{ kind: "Domain"; domain: Hostname }>
  | Readonly<{ kind: "Answered"; response: Response }> => {
  const domain = Hostname.fromInput(raw);
  if (domain === undefined) {
    return { kind: "Answered", response: notFound(c, "domain") };
  }
  return domain === raw
    ? { kind: "Domain", domain }
    : {
        kind: "Answered",
        response: pageRedirect(c, `/admin/instances/${encodeURIComponent(domain)}`),
      };
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
  const health = await findDeliveryDomainHealth(c.env.DB, path.domain);
  if (health.isErr()) {
    return serverError(c, health.error);
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
      { domain: path.domain, blocked: block.value !== undefined, form, health: health.value },
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
  if (form.value.do === "mark_available") {
    return markAvailable(c, domain);
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
      : pageRedirect(c, withNotice("/admin/instances", "block_removed"), 303);
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
    ? await changeDomainBlock(c.env, existing.value.id, settings)
    : await createDomainBlock(c.env, identity.value.domain, domain, settings);
  if (saved.isOk()) {
    return pageRedirect(c, withNotice(`/admin/instances/${domain}`, "block_saved"), 303);
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

/**
 * Mastodon's "Mark as available" (`Admin::InstancesController#restart_delivery`):
 * forget the domain's delivery failures, so deliveries to it start again.
 */
const markAvailable = async (
  c: Context<{ Bindings: Env }, "/admin/instances/:domain">,
  domain: Hostname,
) => {
  const health = await findDeliveryDomainHealth(c.env.DB, domain);
  if (health.isErr()) {
    return serverError(c, health.error);
  }
  if (health.value === undefined) {
    return notFound(c, "delivery failure record");
  }
  const cleared = await clearDeliveryDomainHealth(c.env.DB, domain);
  if (cleared.isErr()) {
    return serverError(c, cleared.error);
  }
  logDeliveryDomainChange(
    c.env,
    domain,
    {
      kind: "Cleared",
      wasUnavailable: health.value.kind === "Unavailable",
      failureDays: health.value.failureDays,
    },
    "admin",
  );
  return pageRedirect(c, withNotice(`/admin/instances/${domain}`, "marked_available"), 303);
};

warmSchemas([DomainBlockFormSchema]);
