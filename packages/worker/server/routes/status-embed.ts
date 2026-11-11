import type { Context } from "hono";
import { statusEmbedPage } from "../web-app";

/** `GET /users/:username/statuses/:id/embed`: the alias of `/@:username/:id/embed`. */
export const getUsersByUsernameStatusesByIdEmbed = (
  c: Context<{ Bindings: Env }, "/users/:username/statuses/:id/embed">,
) => statusEmbedPage(c, c.req.param("username"), c.req.param("id"));
