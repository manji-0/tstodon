import type { Context } from "hono";
import {
  jsonAuthError,
  jsonRepositoryError,
  jsonValidationError,
  readBody,
  requireUser,
} from "../http";
import {
  getMarkers,
  markerBodySchema,
  type MarkerTimeline,
  parseMarkerTimelines,
  upsertMarkers,
} from "../marker-store";

export const getV1Markers = async (c: Context<{ Bindings: Env }, "/api/v1/markers">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const url = new URL(c.req.url);
  const timelines = parseMarkerTimelines([
    ...url.searchParams.getAll("timeline[]"),
    ...url.searchParams.getAll("timeline"),
  ]);
  if (timelines.length === 0) {
    return c.json({});
  }
  const markers = await getMarkers(c.env.DB, user.value.id, timelines);
  if (markers.isErr()) {
    return jsonRepositoryError(c, markers.error.message);
  }
  return c.json(markers.value);
};

export const postV1Markers = async (c: Context<{ Bindings: Env }, "/api/v1/markers">) => {
  const user = await requireUser(c);
  if (user.isErr()) {
    return jsonAuthError(c, user.error);
  }
  const body = await readBody(c, markerBodySchema);
  if (body.isErr()) {
    return jsonValidationError(c);
  }
  const patches: Array<{ timeline: MarkerTimeline; last_read_id: string }> = [];
  if (body.value.home?.last_read_id) {
    patches.push({ timeline: "home", last_read_id: body.value.home.last_read_id });
  }
  if (body.value.notifications?.last_read_id) {
    patches.push({
      timeline: "notifications",
      last_read_id: body.value.notifications.last_read_id,
    });
  }
  const markers = await upsertMarkers(c.env.DB, user.value.id, patches);
  if (markers.isErr()) {
    return jsonRepositoryError(c, markers.error.message);
  }
  return c.json(markers.value);
};
