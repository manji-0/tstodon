// Request body caps after the rate limits, before any route reads a body
// (see server/body-limit.ts).
import { bodyLimitMiddleware } from "#server/body-limit";

export default bodyLimitMiddleware;
