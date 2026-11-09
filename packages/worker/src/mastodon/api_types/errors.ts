import type { ValidationError } from '@tstodon/api';

// The error shapes live in @tstodon/api (packages/api), shared with the server.
export type { ErrorToken, ValidationError } from '@tstodon/api';

export interface ValidationErrorResponse {
  error: string;
  details: Record<string, ValidationError[]>;
}
