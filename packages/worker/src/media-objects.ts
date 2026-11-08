/** R2 takes at most 1,000 keys per `delete`. */
const DELETE_KEYS_PER_CALL = 1000;

/**
 * Delete the bucket objects of media rows already deleted from D1. The rows
 * go first so nothing names a missing object; a failed bucket delete only
 * leaves unreachable objects behind, and is logged with `context`.
 */
export const deleteMediaObjects = async (
  env: Env,
  objectKeys: ReadonlyArray<string>,
  context: Readonly<Record<string, string>>,
): Promise<void> => {
  for (let start = 0; start < objectKeys.length; start += DELETE_KEYS_PER_CALL) {
    const keys = objectKeys.slice(start, start + DELETE_KEYS_PER_CALL);
    try {
      await env.MEDIA.delete([...keys]);
    } catch (error) {
      console.error(
        JSON.stringify({
          kind: "MediaObjectsNotDeleted",
          ...context,
          keys: keys.length,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
};
