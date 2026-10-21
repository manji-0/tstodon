import { Hono } from "hono";
import { filterV1Routes } from "./filters/v1";
import { filterV2Routes } from "./filters/v2";
import { filterKeywordRoutes } from "./filters/keywords";
import { filterStatusRoutes } from "./filters/statuses";

/** `/api/v1/filters` and `/api/v2/filters`, with v2's keywords and statuses. */
export const filterRoutes = new Hono<{ Bindings: Env }>();

filterRoutes.route("/", filterV1Routes);
filterRoutes.route("/", filterV2Routes);
filterRoutes.route("/", filterKeywordRoutes);
filterRoutes.route("/", filterStatusRoutes);
