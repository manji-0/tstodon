import {
  type ActivityId,
  type InstanceIdentity,
  IsoInstant,
  RemoteBoost,
  type RemoteBoostValue,
  type StatusTargetValue,
  type RemoteStatusValue,
  StatusId,
  type Visibility,
} from "@tstodon/domain";
import { schemaResult } from "@tstodon/core";
import { ok, type Result } from "neverthrow";
import { z } from "zod";
import { parseLocalStatusId } from "./activitypub";
import { nowIso } from "./clock";
import type { RepositoryError } from "./d1";
import { stringList } from "./form-values";
import { entityIdAt, type IdClock, newEntityId } from "./ids";
import { insertRemoteBoost } from "./remote-boost-store";
import { findStatusById } from "./status-store";

const AnnounceEnvelopeSchema = z.object({
  to: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  published: z.string().optional(),
});

const parseAnnounceEnvelope = schemaResult(AnnounceEnvelopeSchema);

const NO_ENVELOPE: z.infer<typeof AnnounceEnvelopeSchema> = {};

/** The status an `Announce` names, if it is a local note or the cached remote one. */
const announcedTarget = async (
  db: D1Database,
  identity: InstanceIdentity,
  objectUri: string,
  remote: RemoteStatusValue | undefined,
): Promise<
  Result<
    Readonly<{ target: StatusTargetValue; visibility: Visibility }> | undefined,
    RepositoryError
  >
> => {
  const localId = parseLocalStatusId(identity, objectUri);
  if (!localId) {
    return ok(
      remote && {
        target: { kind: "RemoteStatus", statusId: remote.id },
        visibility: remote.visibility,
      },
    );
  }
  const local = await findStatusById(db, localId);
  return local.map((status) =>
    status?.kind === "LocalNote"
      ? { target: { kind: "LocalStatus", statusId: status.id }, visibility: status.visibility }
      : undefined,
  );
};

/**
 * Keep a remote actor's `Announce` as a boost on its followers' home
 * timelines. `remote` is the announced remote note once cached; a local note
 * is looked up by its URI. Resolves to the boost when it is newly recorded.
 * `idClock` says which instant the boost sorts at on timelines.
 */
export const recordRemoteBoost = async (
  db: D1Database,
  identity: InstanceIdentity,
  actorUri: string,
  announce: Readonly<{ id: ActivityId; object: string }>,
  rawAnnounce: unknown,
  remote: RemoteStatusValue | undefined,
  idClock: IdClock = "Received",
): Promise<Result<RemoteBoostValue | undefined, RepositoryError>> => {
  const target = await announcedTarget(db, identity, announce.object, remote);
  if (target.isErr() || !target.value) {
    return target.map(() => undefined);
  }
  const envelope = parseAnnounceEnvelope(rawAnnounce).unwrapOr(NO_ENVELOPE);
  const publishedAt = IsoInstant.parse(envelope.published ?? "").orElse(() =>
    IsoInstant.parse(nowIso()),
  );
  if (publishedAt.isErr()) {
    return ok(undefined);
  }
  const id = StatusId.parse(
    idClock === "Published" ? entityIdAt(Date.parse(publishedAt.value)) : newEntityId(),
  );
  if (id.isErr()) {
    return ok(undefined);
  }
  const boost = RemoteBoost.fromAnnounce({
    id: id.value,
    actorUri,
    activityId: announce.id,
    target: target.value.target,
    targetVisibility: target.value.visibility,
    to: stringList(envelope.to),
    cc: stringList(envelope.cc),
    publishedAt: publishedAt.value,
  });
  if (boost.isErr()) {
    return ok(undefined);
  }
  const inserted = await insertRemoteBoost(db, boost.value);
  return inserted.map((isNew) => (isNew ? boost.value : undefined));
};
