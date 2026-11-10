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
