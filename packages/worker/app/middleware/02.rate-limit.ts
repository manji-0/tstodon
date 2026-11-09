// Rate limits after CORS (so a 429 reaches browser clients) and before the
// discovery documents and routes (see server/rate-limit.ts and
// docs/reference/configuration.md).
import { rateLimitMiddleware } from "#server/rate-limit";

export default rateLimitMiddleware();
