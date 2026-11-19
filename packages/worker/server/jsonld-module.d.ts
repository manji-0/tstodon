/** The part of jsonld.js (v9) the Worker uses; `@types/jsonld` describes v1. */
declare module "jsonld" {
  type RemoteDocument = Readonly<{
    contextUrl: string | null;
    documentUrl: string;
    document: unknown;
  }>;

  type CanonizeOptions = Readonly<{
    format: "application/n-quads";
    /** Resolves every context URL a document names; the Worker's never fetches. */
    documentLoader: (url: string) => Promise<RemoteDocument>;
    /** `false` drops terms that do not expand, as Mastodon's processor does. */
    safe: boolean;
    canonizeOptions?: Readonly<{ algorithm?: "RDFC-1.0" | "URDNA2015"; maxWorkFactor?: number }>;
  }>;

  const jsonld: Readonly<{
    canonize: (input: unknown, options: CanonizeOptions) => Promise<string>;
  }>;
  export default jsonld;
}
