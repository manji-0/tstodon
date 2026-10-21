import { Hono } from "hono";
import { statusCreateRoutes } from "./statuses/create";
import { statusEngagementRoutes } from "./statuses/engagement";
import { statusReadRoutes } from "./statuses/read";
import { statusEditRoutes } from "./statuses/edit";
import { statusInteractionRoutes } from "./statuses/interactions";

/** `/api/v1/statuses/*`, `/api/v1/favourites`, and `/api/v1/bookmarks`, one router per concern. */
export const statusRoutes = new Hono<{ Bindings: Env }>();

statusRoutes.route("/", statusCreateRoutes);
statusRoutes.route("/", statusEngagementRoutes);
statusRoutes.route("/", statusReadRoutes);
statusRoutes.route("/", statusEditRoutes);
statusRoutes.route("/", statusInteractionRoutes);
