import type { Context } from "hono";
import { errorPage } from "../auth-pages";
import {
  findOwnSeveranceEvent,
  listAccountSeveranceEvents,
  listSeveredFollows,
  type SeveranceDirection,
} from "../severed-relationship-store";
import {
  followersCsv,
  followingCsv,
  severedCsvFilename,
  severedRelationshipsPage,
} from "../severed-pages";
import { instanceName, settingsAccount } from "./account-settings";

type Params = Context<{ Bindings: Env }>;

/** `GET /severed_relationships`: the signed-in account's events, newest first. */
export const getSeveredRelationships = async (c: Params) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const events = await listAccountSeveranceEvents(c.env.DB, signedIn.account.id);
  return events.isErr()
    ? c.html(errorPage(instanceName(c.env), "The server could not read your events."), 500)
    : c.html(severedRelationshipsPage(instanceName(c.env), events.value));
};

const DOWNLOADS: Readonly<Record<string, SeveranceDirection>> = {
  "followers.csv": "followers",
  "following.csv": "following",
};

/**
 * `GET /severed_relationships/:id/followers.csv` and `…/following.csv`: the
 * accounts an event cost the signed-in account. Another account's event id
 * answers as no event.
 */
export const getSeveredRelationshipsFile = async (c: Params) => {
  const signedIn = await settingsAccount(c);
  if (signedIn.kind === "Answered") {
    return signedIn.response;
  }
  const missing = () =>
    c.html(errorPage(instanceName(c.env), "There is no such file to download."), 404);
  const direction = DOWNLOADS[c.req.param("file") ?? ""];
  if (!direction) {
    return missing();
  }
  const event = await findOwnSeveranceEvent(c.env.DB, signedIn.account.id, c.req.param("id") ?? "");
  if (event.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not read the event."), 500);
  }
  if (!event.value) {
    return missing();
  }
  const follows = await listSeveredFollows(c.env.DB, event.value, direction);
  if (follows.isErr()) {
    return c.html(errorPage(instanceName(c.env), "The server could not read the event."), 500);
  }
  return new Response(
    direction === "following" ? followingCsv(follows.value) : followersCsv(follows.value),
    {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${severedCsvFilename(direction, event.value)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
};
