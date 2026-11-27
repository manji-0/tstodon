#!/usr/bin/env node
// Writes packages/worker/server/rfc9421-components.fixture.ts: the signature
// base Mastodon's `linzer` 0.8.0 builds for RFC 9421 covered components with
// parameters (`;sf`, `;key`, `;bs`, `@query-param;name`, `;req`, `;tr`), each
// signed with RFC 9421's test-key-rsa. `rfc9421-components.test.ts` holds
// tstodon to it. Run once per Mastodon release; the tests need no Ruby. It
// runs scripts/rfc9421-components-reference.rb in the Mastodon image
// (Docker), or with a local `ruby` when LINZER_RUBYLIB names the `linzer`,
// `starry`, `rack` and `uri` gems' `lib` directories (`:`-separated):
//
//   node scripts/generate-rfc9421-components-reference.mjs && pnpm fmt
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const image = process.env.MASTODON_IMAGE ?? "ghcr.io/mastodon/mastodon:v4.7.6";
const params = ';created=1618884473;keyid="test-key-rsa"';

/** RFC 9421 B.2's test-request, with the fields section 2.1 uses. */
const testRequest = {
  method: "POST",
  url: "https://example.com/foo?param=Value&Pet=dog",
  headers: {
    Host: "example.com",
    Date: "Tue, 20 Apr 2021 02:07:55 GMT",
    "Content-Type": "application/json",
    "Content-Length": "18",
  },
};

const on = (request, name, components, headers = {}) => ({
  ...request,
  name,
  headers: { ...request.headers, ...headers },
  signatureInput: `(${components})${params}`,
});

/** Section 2.1.1's dictionary, as sent. */
const sentDict = { "Example-Dict": " a=1,    b=2;x=1;y=2,   c=(a   b   c)" };
/** Section 2.1.2's dictionary. */
const memberDict = { "Example-Dict": " a=1, b=2;x=1;y=2, c=(a   b    c), d" };
const query = (url) => ({ method: "GET", url, headers: { Host: "www.example.com" } });
const rfcQuery = query("https://www.example.com/path?param=value&foo=bar&baz=batman&qux=");
const encodedQuery = query(
  "https://www.example.com/parameters?var=this%20is%20a%20big%0Amultiline%20value&bar=with+plus+whitespace&fa%C3%A7ade%22%3A%20=something",
);

const cases = [
  // RFC 9421 section 2.1.1.
  on(testRequest, "sf reserializes a dictionary", '"example-dict";sf', sentDict),
  // RFC 9421 section 2.1.2.
  on(
    testRequest,
    "key takes dictionary members",
    '"example-dict";key="a" "example-dict";key="d" "example-dict";key="b" "example-dict";key="c"',
    memberDict,
  ),
  // RFC 9421 section 2.1.3, one field line and two.
  on(testRequest, "bs wraps a field line", '"example-header";bs', {
    "Example-Header": "value, with, lots, of, commas",
  }),
  on(testRequest, "bs wraps field lines as one", '"example-header";bs', {
    "Example-Header": ["value, with, lots", "of, commas"],
  }),
  // RFC 9421 section 2.2.8.
  {
    ...on(rfcQuery, "query-param names", ""),
    signatureInput: `("@query-param";name="baz" "@query-param";name="qux" "@query-param";name="param")${params}`,
  },
  {
    ...on(encodedQuery, "query-param encodes", ""),
    signatureInput: `("@query-param";name="var" "@query-param";name="bar" "@query-param";name="fa%C3%A7ade%22%3A%20")${params}`,
  },
  // RFC 9421 B.2.2's covered components.
  on(testRequest, "B.2.2 components", '"@authority" "content-digest" "@query-param";name="Pet"', {
    "Content-Digest":
      "sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:",
  }),
  // What `linzer` refuses.
  on(testRequest, "a missing key", '"example-dict";key="z"', memberDict),
  on(testRequest, "a key that is a token", '"example-dict";key=a', memberDict),
  on(testRequest, "sf on a field that is not a dictionary", '"date";sf'),
  on(testRequest, "sf on an empty field", '"example-dict";sf', { "Example-Dict": "" }),
  on(testRequest, "sf on a missing field", '"example-dict";sf'),
  on(testRequest, "sf with bs", '"example-dict";sf;bs', memberDict),
  on(testRequest, "key with bs", '"example-dict";key="a";bs', memberDict),
  on(testRequest, "req on a request", '"@method";req'),
  on(testRequest, "req on a field of a request", '"content-type";req'),
  on(testRequest, "tr on a field", '"content-type";tr'),
  on(testRequest, "tr on a derived component", '"@method";tr'),
  on(testRequest, "name on another component", '"@method";name="x"'),
  on(testRequest, "an unknown parameter", '"content-type";foo'),
  on(testRequest, "query-param without a name", '"@query-param"'),
  on(testRequest, "query-param with a token name", '"@query-param";name=Pet'),
  on(testRequest, "query-param with an absent name", '"@query-param";name="pet"'),
  on(testRequest, "status on a request", '"@status"'),
  on(
    testRequest,
    "the same member twice",
    '"example-dict";key="a" "example-dict";key="a"',
    memberDict,
  ),
  on(
    testRequest,
    "the same parameters in another order",
    '"example-dict";key="a";sf "example-dict";sf;key="a"',
    memberDict,
  ),
  on(testRequest, "bs on a missing field", '"example-header";bs'),
  // What `linzer` takes that RFC 9421 does not define.
  on(testRequest, "bs on a derived component", '"@method";bs'),
  on(testRequest, "sf=?0, read as no sf", '"example-dict";sf=?0', sentDict),
  on(testRequest, "key with sf=?0", '"example-dict";key="b";sf=?0', memberDict),
  on(
    testRequest,
    "the same component with and without sf",
    '"example-dict" "example-dict";sf',
    sentDict,
  ),
  on(testRequest, "query-param with bs", '"@query-param";name="Pet";bs'),
  // Structured-field reserialization.
  on(testRequest, "sf on members with parameters", '"example-dict";sf', {
    "Example-Dict": "a;p=1;q, b=?0;x=?1, c=1.50, d=-7, e=tok/en:x, f=:YWJj:, g=();p",
  }),
  on(testRequest, "key on a member with parameters", '"example-dict";key="a"', {
    "Example-Dict": "a;p=1;q, b",
  }),
  on(testRequest, "key on an empty inner list", '"example-dict";key="g"', {
    "Example-Dict": "g=();p=?0",
  }),
  on(testRequest, "sf on a string member", '"example-dict";sf', { "Example-Dict": 'a="x y"' }),
  on(testRequest, "key on a string member", '"example-dict";key="a"', {
    "Example-Dict": 'a="x\\"y"',
  }),
  on(testRequest, "sf on a repeated member", '"example-dict";sf', {
    "Example-Dict": "a=1, b=2, a=3",
  }),
  on(testRequest, "sf on a field sent on two lines", '"example-dict";sf', {
    "Example-Dict": ["a=1", "b=2"],
  }),
  on(testRequest, "sf on a field that does not parse", '"example-dict";sf', {
    "Example-Dict": "a=1,",
  }),
  // Query parameters as Rack parses them.
  {
    ...on(query("https://example.com/q?a=1&a=2&b&c=&d=x+y&e=%7E*-._%21"), "query-param values", ""),
    signatureInput: `("@query-param";name="a" "@query-param";name="b" "@query-param";name="c" "@query-param";name="d" "@query-param";name="e")${params}`,
  },
  {
    ...on(
      query("https://example.com/q?a%2Bb=1&c+d=2&f=1&%20g=3"),
      "query-param name encodings",
      "",
    ),
    signatureInput: `("@query-param";name="a%2Bb" "@query-param";name="c%20d" "@query-param";name=" g")${params}`,
  },
  on(
    query("https://example.com/q?a+b=1"),
    "query-param name with a plus",
    '"@query-param";name="a+b"',
  ),
  on(
    query("https://example.com/q?a=1&%zz=2"),
    "query-param in a query with a bad escape",
    '"@query-param";name="a"',
  ),
  on(
    query("https://example.com/q?a=1"),
    "query-param with a bad escape in its name",
    '"@query-param";name="%zz"',
  ),
  on(
    query("https://example.com/q?a=1&%20b=2"),
    "query-param after a separator with spaces",
    '"@query-param";name="b"',
  ),
  on(
    query("https://example.com/q?a=1;b=2"),
    "query-param across a semicolon",
    '"@query-param";name="a"',
  ),
  on(
    query("https://example.com/q?a[b]=1"),
    "query-param on a nested name",
    '"@query-param";name="a[b]"',
  ),
  on(
    query("https://example.com/q?a[]=1"),
    "query-param on an array name",
    '"@query-param";name="a[]"',
  ),
  on(
    query("https://example.com/q?c=1&a=1&a[b]=2"),
    "query-param in a query Rack cannot nest",
    '"@query-param";name="c"',
  ),
  on(
    query("https://example.com/q?a[b]=1&c=2"),
    "query-param beside a nested name",
    '"@query-param";name="c"',
  ),
  on(
    query("https://example.com/q?[a]=1"),
    "query-param on a name that opens with a bracket",
    '"@query-param";name="[a]"',
  ),
  on(
    query("https://example.com/q?a=%C3%A7&b=%FF"),
    "query-param on non-ASCII values",
    '"@query-param";name="a" "@query-param";name="b"',
  ),
  on(
    query("https://example.com/q?=1&a=2"),
    "query-param with an empty name",
    '"@query-param";name=""',
  ),
];

const multipleSignatures = {
  signatureInput: `sig1=("@method")${params}, sig2=("@method")${params}`,
  signature: "sig1=:AA==:, sig2=:AA==:",
};

const input = JSON.stringify({ cases, multipleSignatures });
const local = process.env.LINZER_RUBYLIB;
const run =
  local === undefined
    ? spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "-v",
          `${path("./rfc9421-components-reference.rb")}:/reference.rb:ro`,
          "--entrypoint",
          "sh",
          image,
          "-c",
          "cd /opt/mastodon && bundle exec ruby /reference.rb",
        ],
        { input, maxBuffer: 64 * 1024 * 1024 },
      )
    : spawnSync("ruby", [path("./rfc9421-components-reference.rb")], {
        input,
        env: { ...process.env, RUBYLIB: local },
        maxBuffer: 64 * 1024 * 1024,
      });
if (run.status !== 0) {
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
}
const reference = JSON.parse(run.stdout.toString());
const results = new Map(reference.cases.map((result) => [result.name, result]));

writeFileSync(
  path("../packages/worker/server/rfc9421-components.fixture.ts"),
  `// Generated by scripts/generate-rfc9421-components-reference.mjs from ${local === undefined ? image : "linzer 0.8.0"}; do not edit.
// The signature base Mastodon's \`linzer\` builds for each request and covered components, signed with RFC 9421's test-key-rsa.

export type ComponentCase = Readonly<{
  name: string;
  method: string;
  url: string;
  /** A list is a field sent on several lines. */
  headers: Readonly<Record<string, string | ReadonlyArray<string>>>;
  /** The inner list and parameters filed under \`sig1\`. */
  signatureInput: string;
  /** The signature base; \`null\` when \`linzer\` refuses the components. */
  base?: string | null;
  /** The error \`linzer\` raises unrescued (a 500 in Mastodon) in place of a base. */
  raises?: string;
  /** The base on Puma's binary header strings, where it differs. */
  pumaBase?: string | null;
  /** \`rsa-v1_5-sha256\` over \`base\`, in base64. */
  signature?: string;
}>;

export const LINZER_COMPONENT_CASES: ReadonlyArray<ComponentCase> = ${JSON.stringify(
    cases.map((entry) => ({ ...entry, ...results.get(entry.name) })),
    null,
    2,
  )};

/** What \`Linzer::Signature.build\` raises for a \`Signature-Input\` naming two signatures. */
export const LINZER_MULTIPLE_SIGNATURES = ${JSON.stringify({ ...multipleSignatures, raises: reference.multipleSignatures })};
`,
);
