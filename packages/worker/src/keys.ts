const toPem = (label: string, der: ArrayBuffer): string => {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const b64 = btoa(binary);
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
};

export const generateAccountKeys = async (): Promise<{
  publicKeyPem: string;
  privateKeyJwk: string;
}> => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair) || !("publicKey" in pair)) {
    throw new Error("expected an RSA key pair");
  }
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  if (!(spki instanceof ArrayBuffer)) {
    throw new Error("expected SPKI ArrayBuffer");
  }
  return {
    publicKeyPem: toPem("PUBLIC KEY", spki),
    privateKeyJwk: JSON.stringify(privateJwk),
  };
};
