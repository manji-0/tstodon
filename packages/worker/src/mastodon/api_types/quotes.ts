// The REST shapes live in @tstodon/api (packages/api), shared with the server.

import { isQuotePolicyName } from '@tstodon/api/values';

import type { ApiQuotePolicy } from '@tstodon/api';

export type {
  ApiQuoteState,
  ApiQuotePolicy,
  ApiUserQuotePolicy,
  ApiQuotedStatusJSON,
  ApiQuoteJSON,
  ApiQuotePolicyJSON,
} from '@tstodon/api';

export function isQuotePolicy(policy: string): policy is ApiQuotePolicy {
  return isQuotePolicyName(policy);
}
