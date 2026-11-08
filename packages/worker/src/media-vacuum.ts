import { MediaVacuum, type MediaVacuumPass } from "@tstodon/domain";
import type { Result } from "neverthrow";
import type { RepositoryError } from "./d1";
import { deleteMediaObjects } from "./media-objects";
import { deleteUnattachedMedia } from "./media-store";

/**
 * One pass of the media sweep: the oldest media unattached for over a day
 * that no scheduled post or edit history names, rows and objects. Only local
 * uploads live in `media_attachments`; remote media is never stored here.
 */
export const vacuumMediaAttachments = (
  env: Env,
  nowMs: number = Date.now(),
): Promise<Result<MediaVacuumPass, RepositoryError>> =>
  MediaVacuum.pass(
    {
      deleteRows: (createdBefore, limit) => deleteUnattachedMedia(env.DB, createdBefore, limit),
      deleteObjects: (objectKeys) =>
        deleteMediaObjects(env, objectKeys, { job: "VacuumMediaAttachments" }),
    },
    nowMs,
  );
