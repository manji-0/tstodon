import { SignJWT, importJWK, type JWK } from "jose";

/** Local/test-only Access signing key. Never use in production. */
export const LOCAL_ACCESS_KID = "tstodon-local-access";

export const LOCAL_ACCESS_PUBLIC_JWK = {
  kty: "RSA",
  n: "qHE50MFXgxUeSKwP4ChF1TRN7gvR1z4bRcTIc7Jcr6qTrccio5BjeveN7dxj8pP985tYQMVI9sx81vEA7v38KzY0Q9UqEgZzd7VP_TGJEm4fxaP7dZSVQWTvrTxNpqCCPml4rc3nNgABRWniSgwCWR1A7d7mpOTicxXG6PApWAPDuRGdBNq2hnkm2fkFSKKf_oyaXjlRZJMYiMR8pOoCb9xrSUKTzrUjK_AvSmt3CcnJwMqMMVn_ZP7-nRi-OogwkOjW0NyUzIle7KQkMYDhHGRMUnZjj6Qwo0yBzvJXXuBjusHTPYHPlSVnY4k9uxA2SojnCUgrM20tGLsmUofpFw",
  e: "AQAB",
  kid: LOCAL_ACCESS_KID,
  alg: "RS256",
  use: "sig",
} as const satisfies JWK;

export const LOCAL_ACCESS_PRIVATE_JWK = {
  ...LOCAL_ACCESS_PUBLIC_JWK,
  d: "AsdDVd8qi134zugPpvnjFP403t1RC8TZfFAfolDp2Hfu0an8N0h1a5zTuX2uJF0ujisczIy0hGWhFYaKJmcIFsphGFFWzU9P7kSOWjXL9gLdAUyQJENcJuT8UxYwjbQOEet5cxx3WNutKbDya5hBHaku3f2UPloMJivQyRzVAb-fRdZR4ImfmfHbeKRgB3TGETAfaR1hJGWSmPEZVOrLBDo6hGoccJ_-4L1j5nCpZVZ2grXOqFqofotZmeB8aGNDaWAe365FmD4vO9iv5p0Yu5s-OPT4sfKkYFhz_59JyoW4mGB0qoYzDgOM_Q5edHKqhZVMOe6GDHEz6qwBVRYnIQ",
  p: "4gAUZ8Fnfjs1bKZk5SR0c7Zh5OUqIMguH63RxfF3pe45P5U7ZLtqdP6SrrMhYbPTrBNsQcQydsVGJgaRyxf553A3QiSP4WYu7cvqHCiJ1dMJj251yVUta2-CFLSDHv3R0bjp4E_1_MgVgfaWTlfk2haRyeahVBq1nMuHUpTUYEc",
  q: "vs03DytptttgweXwU1V8Muv_8J7_-QMBCU-Iypb_wdwLMbVM18CKB0iJKXty2teIvfY7oNOfKZyuJ6GjEEshKQGLZOIF07jRcsc6ckuC69wv6hNR6dF5TG2dWW32lQUM4oCHa7WwZKFYIAM-W-SuFzrgMAbENdTteR-D3tmH6LE",
  dp: "wDdJI6X_HAHHwo0TK0ECOphYUpIGbrNTZ2YzEKP7G4mt70JBrb8pIDCVGTkJn0uPML-kR5tTQGkw7I6R2aaeyhVLKlpmdVKvf1j72M8xzEcdznwoegCUDNheTrXo_6bpmfIoGLxpf4G9qTfNRvzCjCq9_HbHp_y_kogYpEgpCWk",
  dq: "bxayYO2oziMqUZpb81kJR-iqCmG4rTW3i8E35qRF4owIJHfndpKOirEL0xAiDhKBdgCANSIhQCwOJdrxQtJLS0Gv9Bu4ws2PfOFMQTF_121KpGF9RsKEeiA0BdaFQ7w-BT5KGkcdnWlnErRwwTYCulm4H55A7Qq8_NGBiOVkQPE",
  qi: "A3Uy5wXgpeDH9l1qxhKtN_O-3F6Ia_mhWeG6mTaNUlKXjI6cJ4rjdEnQCZaZk8IPGWfDutxG9-FQgklx_TgHFc0jdJGuabtNl3QlYTY-QSsKcfq1qQaRRC-n3CB6MiP-CEm3E-6ufbAE1J2YOqgkfv_sB9WvCWPkzJANZJSbEFk",
} as const satisfies JWK;

export const LOCAL_ACCESS_JWKS = { keys: [LOCAL_ACCESS_PUBLIC_JWK] } as const;

export const LOCAL_ACCESS_TEAM_DOMAIN = "https://tstodon.cloudflareaccess.com";
export const LOCAL_ACCESS_AUD = "tstodon-local-aud";
export const LOCAL_ACCESS_ADMIN_GROUP = "tstodon-admins";

export const LOCAL_ACCESS_JWKS_JSON = JSON.stringify(LOCAL_ACCESS_JWKS);
export const LOCAL_ACCESS_PRIVATE_JWK_JSON = JSON.stringify(LOCAL_ACCESS_PRIVATE_JWK);

export type SignAccessJwtInput = Readonly<{
  email: string;
  groups?: ReadonlyArray<string>;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}>;

export const signAccessJwt = async (input: SignAccessJwtInput): Promise<string> => {
  const key = await importJWK(LOCAL_ACCESS_PRIVATE_JWK, "RS256");
  const groups = input.groups ?? [];
  return new SignJWT({
    email: input.email,
    type: "app",
    groups: [...groups],
    custom: { groups: [...groups] },
  })
    .setProtectedHeader({ alg: "RS256", kid: LOCAL_ACCESS_KID, typ: "JWT" })
    .setIssuer(input.issuer ?? LOCAL_ACCESS_TEAM_DOMAIN)
    .setAudience(input.audience ?? LOCAL_ACCESS_AUD)
    .setSubject(input.email)
    .setIssuedAt()
    .setExpirationTime(input.expiresIn ?? "2h")
    .sign(key);
};

export const accessAuthHeaders = async (
  email: string,
  options?: Readonly<{ admin?: boolean; via?: "bearer" | "assertion" }>,
): Promise<Record<string, string>> => {
  const groups = options?.admin ? [LOCAL_ACCESS_ADMIN_GROUP] : [];
  const token = await signAccessJwt({ email, groups });
  if (options?.via === "assertion") {
    return { "Cf-Access-Jwt-Assertion": token };
  }
  return { Authorization: `Bearer ${token}` };
};
