import { schemaResult } from "@tstodon/core";
import { z } from "zod";

/**
 * A public key a remote actor publishes, as Mastodon keeps one (`Keypair`):
 * its id (the `keyId` a signature names) and the key as SPKI PEM. `Rsa`
 * comes from a `publicKey` or an `rsa-pub` Multikey; `Ed25519` from an
 * `ed25519-pub` Multikey (FEP-521a `assertionMethod`). An RSA key verifies
 * HTTP and Linked Data signatures; an Ed25519 key verifies `eddsa-jcs-2022`
 * integrity proofs (FEP-8b32) and RFC 9421 HTTP message signatures, not
 * draft-cavage ones.
 */
const RemoteActorKeySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("Rsa"),
    keyId: z.string().min(1),
    publicKeyPem: z.string().min(1),
  }),
  z.object({
    kind: z.literal("Ed25519"),
    keyId: z.string().min(1),
    publicKeyPem: z.string().min(1),
  }),
]);

export type RemoteActorKey = z.infer<typeof RemoteActorKeySchema>;

export const RemoteActorKey = {
  schema: RemoteActorKeySchema,
  parse: schemaResult(RemoteActorKeySchema),
} as const;
