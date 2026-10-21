import { Hono } from "hono";
import { accountCredentialRoutes } from "./accounts/credentials";
import { accountLookupRoutes } from "./accounts/lookup";
import { accountProfileRoutes } from "./accounts/profile";
import { accountFollowRoutes } from "./accounts/follows";
import { accountBlockMuteRoutes } from "./accounts/blocks-mutes";
import { accountEndorsementRoutes } from "./accounts/endorsements";

/**
 * `/api/v1/accounts/*` and the viewer's account lists, one router per
 * concern. Fixed paths (`verify_credentials`, `lookup`, `search`, ...) mount
 * before the router holding `/api/v1/accounts/:id`, which would otherwise match them.
 */
export const accountRoutes = new Hono<{ Bindings: Env }>();

accountRoutes.route("/", accountCredentialRoutes);
accountRoutes.route("/", accountLookupRoutes);
accountRoutes.route("/", accountProfileRoutes);
accountRoutes.route("/", accountFollowRoutes);
accountRoutes.route("/", accountBlockMuteRoutes);
accountRoutes.route("/", accountEndorsementRoutes);
