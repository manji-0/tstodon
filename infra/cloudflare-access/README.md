# Cloudflare Access for tstodon

<!-- constrained-by ../../docs/reference/configuration.md#cloudflare-access-authentication-vars -->
<!-- constrained-by ../../docs/operations/cloudflare-deploy.md -->

Terraform skeleton that configures Cloudflare Access in front of the tstodon Worker, with **WorkOS as the OIDC identity provider**.

The Worker still verifies Access JWTs itself (`packages/worker/src/auth.ts`). This stack only provisions the Zero Trust edge pieces and prints the Worker vars to set.

## What it creates

| Resource | Purpose |
| --- | --- |
| WorkOS OIDC IdP | Access login method (`type = oidc`) |
| Allow policy | Authenticated users (optional email-domain filter) |
| Bypass policy | Public federation / health paths |
| Access app `tstodon-api` | Protects `https://<hostname>/api*` |
| Bypass apps | Explicit Bypass for `/.well-known*`, `/nodeinfo*`, `/users*`, `/healthz*` |

Paths without an Access application remain publicly reachable (for example ActivityPub extras not listed above). Extend `federation_bypass_uris` in `main.tf` if you add more public surfaces.

## Prerequisites

1. Cloudflare account with Zero Trust enabled and a team domain.
2. API token with:
   - `Access: Apps and Policies Edit`
   - `Access: Organizations, Identity Providers, and Groups Edit`
3. WorkOS OIDC / AuthKit application whose redirect URI is:

   ```text
   https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback
   ```

4. OIDC discovery values from WorkOS (`authorization_endpoint`, `token_endpoint`, `jwks_uri`).

## Usage

```sh
cd infra/cloudflare-access
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — never commit it
export CLOUDFLARE_API_TOKEN=...

terraform init
terraform plan
terraform apply
```

After apply, copy outputs into production Worker vars (and clear local fixture keys):

```sh
terraform output -json worker_vars
```

Suggested mapping:

| Output / field | Worker var |
| --- | --- |
| `cf_access_team_domain` | `CF_ACCESS_TEAM_DOMAIN` |
| `access_application_aud` | `CF_ACCESS_AUD` |
| `cf_access_admin_groups` | `CF_ACCESS_ADMIN_GROUPS` |
| (empty) | `CF_ACCESS_JWKS_JSON` |
| (empty) | `CF_ACCESS_LOCAL_PRIVATE_JWK` |

Example with Wrangler (production environment):

```sh
wrangler secret put CF_ACCESS_AUD   # if you treat AUD as sensitive in your ops model
# or set plain vars via dashboard / wrangler.toml env blocks
```

## WorkOS notes

- Cloudflare registers WorkOS as a **generic OIDC** IdP. There is no first-party "WorkOS" connector type.
- Ensure WorkOS emits a `groups` claim (or another claim listed in `workos_oidc.claims`) so `CF_ACCESS_ADMIN_GROUPS` can map admins in the Worker.
- Large group lists may be trimmed from the Access application JWT; see Cloudflare Access JWT docs. Prefer small admin group names for `tstodon-admins`.

## Out of scope

- Creating the WorkOS OIDC client itself (WorkOS Dashboard / WorkOS API)
- D1 / R2 / Queue provisioning
- Automatically patching `wrangler.jsonc`
