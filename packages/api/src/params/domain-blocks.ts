import { z } from "zod";

/**
 * `POST /api/v1/domain_blocks` (body) and `DELETE /api/v1/domain_blocks`
 * (Mastodon's clients send it in the query; a body works too): the domain
 * to block or unblock. The server checks it is a hostname (422 otherwise).
 */
export const ApiDomainBlockParamsSchema = z.object({
  domain: z.string(),
});
export type ApiDomainBlockParams = z.input<typeof ApiDomainBlockParamsSchema>;

/**
 * `GET /api/v1/domain_blocks/preview` (query): the domain whose follows a
 * block would sever. Left out, Mastodon counts the local accounts' follows.
 */
export const ApiDomainBlockPreviewParamsSchema = z.object({
  domain: z.string().optional(),
});
export type ApiDomainBlockPreviewParams = z.input<typeof ApiDomainBlockPreviewParamsSchema>;
