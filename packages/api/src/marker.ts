import { z } from "zod";

/** `REST::MarkerSerializer`: `version` counts the marker's updates. */
export const ApiMarker = z.object({
  last_read_id: z.string(),
  version: z.number(),
  updated_at: z.string(),
});
export type MarkerJSON = z.infer<typeof ApiMarker>;
export type ApiMarkerJSON = MarkerJSON;

/** `/api/v1/markers`: the requested timelines that have a marker. */
export const ApiMarkers = z.object({
  home: ApiMarker.optional(),
  notifications: ApiMarker.optional(),
});
export type ApiMarkersJSON = z.infer<typeof ApiMarkers>;
