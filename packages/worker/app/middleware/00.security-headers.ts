// Content-Security-Policy, X-Frame-Options, Referrer-Policy and nosniff on
// every answer (see server/security-headers.ts).
import { securityHeadersMiddleware } from "#server/security-headers";

export default securityHeadersMiddleware;
