import { Hono } from "hono";
import { adminCustomEmojiRoutes } from "./admin/custom-emojis";
import { adminAnnouncementRoutes } from "./admin/announcements";
import { adminAccountRoutes } from "./admin/accounts";
import { adminReportRoutes } from "./admin/reports";
import { adminEmailBlockRoutes } from "./admin/email-blocks";
import { adminDomainBlockRoutes } from "./admin/domain-blocks";
import { adminTrendRoutes } from "./admin/trends";
import { adminDomainAllowRoutes } from "./admin/domain-allows";

/** `/api/v1/admin/*`, one router per resource. */
export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.route("/", adminCustomEmojiRoutes);
adminRoutes.route("/", adminAnnouncementRoutes);
adminRoutes.route("/", adminAccountRoutes);
adminRoutes.route("/", adminReportRoutes);
adminRoutes.route("/", adminEmailBlockRoutes);
adminRoutes.route("/", adminDomainBlockRoutes);
adminRoutes.route("/", adminTrendRoutes);
adminRoutes.route("/", adminDomainAllowRoutes);
