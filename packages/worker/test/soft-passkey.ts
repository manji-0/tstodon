/**
 * A software WebAuthn authenticator (ES256, `none` attestation) for driving
 * the real passkey sign-up and sign-in endpoints in tests and e2e runs. Uses
 * only WebCrypto, so it runs in workerd and in Node alike. Test-only.
 */

const encoder = new TextEncoder();

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

export const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

// Just enough CBOR (RFC 8949) for an attestation object and a COSE key.
type Cbor = number | string | Uint8Array | ReadonlyArray<readonly [Cbor, Cbor]>;

const cborHead = (major: number, length: number): Uint8Array => {
  if (length < 24) {
    return Uint8Array.of((major << 5) | length);
  }
  if (length < 0x100) {
    return Uint8Array.of((major << 5) | 24, length);
  }
  return Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff);
};

const cbor = (value: Cbor): Uint8Array => {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = encoder.encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) {
    return concat(cborHead(2, value.length), value);
  }
  return concat(
    cborHead(5, value.length),
    ...value.flatMap(([key, entry]) => [cbor(key), cbor(entry)]),
  );
};

/** WebCrypto signs ECDSA as raw r||s; WebAuthn wants ASN.1 DER. */
const derSignature = (raw: Uint8Array): Uint8Array => {
  const integer = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
      start += 1;
    }
    const trimmed = bytes.slice(start);
    const body = (trimmed[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const sequence = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, sequence.length), sequence);
};

const counterBytes = (counter: number): Uint8Array =>
  Uint8Array.of(
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>> 8) & 0xff,
    counter & 0xff,
  );

export type RegistrationOptionsJson = Readonly<{
  challenge: string;
  rp: { id?: string | undefined };
}>;
export type AuthenticationOptionsJson = Readonly<{ challenge: string; rpId?: string | undefined }>;

export type SoftPasskey = Readonly<{
  credentialId: string;
  /** The `response` body for `/passkey/verify-registration`. */
  register: (options: RegistrationOptionsJson) => Promise<Record<string, unknown>>;
  /** The `response` body for `/passkey/verify-authentication`. */
  authenticate: (options: AuthenticationOptionsJson) => Promise<Record<string, unknown>>;
}>;

/** A new credential for `origin` (whose hostname is the RP ID unless the options name one). */
export const softPasskey = async (origin: string): Promise<SoftPasskey> => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keys)) {
    throw new Error("ECDSA key generation returned no key pair");
  }
  const exported = await crypto.subtle.exportKey("raw", keys.publicKey);
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("raw public key export failed");
  }
  const publicKey = new Uint8Array(exported);
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  const id = toBase64Url(credentialId);
  let counter = 0;

  const clientData = (type: string, challenge: string): Uint8Array =>
    encoder.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  const rpIdHash = (rpId: string | undefined) =>
    sha256(encoder.encode(rpId ?? new URL(origin).hostname));

  return {
    credentialId: id,
    register: async (options) => {
      const coseKey = cbor([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, publicKey.slice(1, 33)],
        [-3, publicKey.slice(33, 65)],
      ]);
      const authData = concat(
        await rpIdHash(options.rp.id),
        // User present, user verified, attested credential data included.
        Uint8Array.of(0x45),
        counterBytes(counter),
        new Uint8Array(16),
        Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
        credentialId,
        coseKey,
      );
      const attestationObject = cbor([
        ["fmt", "none"],
        ["attStmt", []],
        ["authData", authData],
      ]);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(clientData("webauthn.create", options.challenge)),
          attestationObject: toBase64Url(attestationObject),
          transports: ["internal"],
        },
      };
    },
    authenticate: async (options) => {
      counter += 1;
      const clientDataJson = clientData("webauthn.get", options.challenge);
      const authData = concat(
        await rpIdHash(options.rpId),
        Uint8Array.of(0x05),
        counterBytes(counter),
      );
      const signed = concat(authData, await sha256(clientDataJson));
      const signature = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed),
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: toBase64Url(clientDataJson),
          authenticatorData: toBase64Url(authData),
          signature: toBase64Url(derSignature(signature)),
        },
      };
    },
  };
};
