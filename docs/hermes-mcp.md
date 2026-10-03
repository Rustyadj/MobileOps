# Hermes MCP integration

MobileOps exposes an additive Streamable HTTP MCP server at `/api/mcp/`. It does not
replace or proxy the mobile API. MCP tools call the existing FastAPI handlers, so
inventory ledger checks, booking reservations, dispatch state transitions,
returns, maintenance behavior, and shop-task completion side effects remain in
one implementation.

## Security model

- Only the dedicated `hermes-agent` service identity can authenticate.
- The bearer token is stored in MongoDB only as a SHA-256 digest.
- Every tool checks a domain-specific read or write scope.
- Every mutation is marked destructive in MCP metadata and uses a two-call
  confirmation flow. The second call must have the same parameters and a signed,
  five-minute, one-time confirmation token.
- Every attempted tool call is written to `mcp_audit_log` before domain logic is
  entered. The record is completed with timestamp, identity, tool, redacted
  parameters, result/error, status, and duration. Audit creation fails closed.
- Confirmation and bearer tokens are redacted from audit records. Oversize
  results are represented by byte size, SHA-256 digest, and a bounded preview so
  an audit record cannot exceed MongoDB's document limit.
- DNS-rebinding protection validates the public host and any configured origins.
- No delete tool is exposed to Hermes.

The MCP security collections are `mcp_agents`, `mcp_audit_log`, and
`mcp_confirmations`. Rental forecasting adds optional fields to existing domain
documents; see [Nathan2 rental availability](nathan2-rental-availability.md) for
the backward-compatible schema details.

## Deployment configuration

Generate independent random secrets and provide them to the backend process:

```bash
openssl rand -hex 32  # use as HERMES_MCP_TOKEN
openssl rand -hex 32  # use as MCP_CONFIRMATION_SECRET
```

Required for an enabled MCP identity:

```dotenv
HERMES_MCP_TOKEN=<random bearer token shared only with Hermes>
MCP_CONFIRMATION_SECRET=<different random signing secret>
MCP_PUBLIC_URL=https://mobileops.example.com
```

The checked-in default public origin is the production MobileOps host,
`https://icfops.srv1427612.hstgr.cloud`. Set `MCP_PUBLIC_URL` when deploying
under any other hostname.

For the connected Nathan2 deployment, the repository contains only the SHA-256
digest in `backend/hermes-agent-token.sha256`; the high-entropy bearer token is
stored only in Nathan2's protected `/opt/data/.env`. A token digest is not a bearer
credential. `HERMES_MCP_TOKEN` overrides the file when supplied. Deployments may
instead provide `HERMES_MCP_TOKEN_SHA256`, or point
`HERMES_MCP_TOKEN_SHA256_FILE` at another digest file. Set the file variable to
an empty value to disable file-based provisioning.

Optional hardening and scope restriction:

```dotenv
MCP_ISSUER_URL=https://mobileops.example.com
MCP_ALLOWED_HOSTS=mobileops.example.com
MCP_ALLOWED_ORIGINS=https://mobileops.example.com
HERMES_MCP_SCOPES=inventory:read,inventory:write,equipment:read,equipment:write,rentals:read,rentals:write,bookings:read,bookings:write,dispatch:read,dispatch:write,maintenance:read,maintenance:write,shop_tasks:read,shop_tasks:write,operations:read
```

Use HTTPS at the reverse proxy and forward the original `Host` header. Do not
publish the backend over unencrypted HTTP. If neither a token nor a valid digest
is configured, the identity is retained but disabled and MCP requests receive
`401`; the mobile app continues to work normally.

On startup MobileOps idempotently seeds the `hermes-agent` identity and required
indexes. To rotate the credential, replace `HERMES_MCP_TOKEN` in both services and
restart MobileOps, then Hermes. To revoke access immediately, remove the token
from MobileOps and restart it (or set `mcp_agents.enabled` to `false`).

## Connect Nathan2

Hermes Agent 0.20 includes the Streamable HTTP MCP client. The MobileOps backend
pins the matching Python MCP server SDK in `backend/requirements-prod.txt`; do
not install packages interactively into the managed Nathan2 container.

Add this entry to `/opt/data/config.yaml` inside `hermes-nathan2` (host path
`/docker/hermes-nathan2/data/config.yaml`). Keep the URL's trailing slash to
avoid an HTTP redirect. Store the secret in `/opt/data/.env`, not in YAML.

```yaml
mcp_servers:
  mobileops:
    url: "https://mobileops.example.com/api/mcp/"
    headers:
      Authorization: "Bearer ${MCP_MOBILEOPS_API_KEY}"
    timeout: 180
    connect_timeout: 30
    sampling:
      enabled: false
```

Then restrict the configuration and restart Nathan2:

```bash
chmod 640 /opt/data/config.yaml
docker restart hermes-nathan2
docker exec hermes-nathan2 hermes mcp test mobileops
```

Hermes discovers the server on startup. Tools appear with names such as
`mcp_mobileops_inventory_search` and `mcp_mobileops_dispatch_set_status`.

For a mutation, the first result has this shape:

```json
{
  "confirmation_required": true,
  "summary": "Advance dispatch d-123 to loaded.",
  "expires_in_seconds": 300,
  "confirmation_token": "..."
}
```

Hermes must show `summary` to the human. Only after explicit approval should it
repeat the exact call with `confirmation_token`. Changed parameters, expired
tokens, and replayed tokens are rejected and audited.

## Tools and scopes

| Area | Read tools | Mutating tools (confirmation required) | Scope(s) |
|---|---|---|---|
| Inventory/equipment | `inventory_search`, `inventory_capacity`, `inventory_transfers_list`, `equipment_get` | `inventory_transfer`, `inventory_receive_transfer`, `equipment_checkout`, `equipment_checkin`, `equipment_inspect_return` | `inventory:read/write`, `equipment:read/write` |
| Rentals/returns | `rentals_list`, `rental_contact_actions` | `rental_create`, `rental_return`, `rental_schedule_pickup`, `rental_log_communication` | `rentals:read/write` |
| Bookings | `bookings_list` | `booking_create`, `booking_set_status`, `booking_dispatch` | `bookings:read/write` |
| Dispatch | `dispatches_list` | `dispatch_create`, `dispatch_assign`, `dispatch_set_status` | `dispatch:read/write` |
| Maintenance | `maintenance_list` | `maintenance_create`, `maintenance_update` | `maintenance:read/write` |
| Shop | `shop_tasks_list` | `shop_task_create`, `shop_task_set_status`, `shop_task_add_update` | `shop_tasks:read/write` |
| Operations | `operational_status`, `operational_activity`, `export_report` | — | `operations:read` |

`export_report(dataset, format, ...filters)` generates an Excel (`xlsx`), `pdf` or `csv`
report, **stores it** (14 days, see [Documents](#documents-excel-pdf-and-imports)) and returns a
10-minute signed `download_url`. Datasets: `equipment` (inventory), `tools`, `assignments`
(tools checked out), `damaged`, `rentals`, `returns` (inbound), `outbound`, `dispatches`,
`maintenance`, `shop_tasks`, `consumables`, `block`. Filters are equality only and an
unsupported filter is an error: `status`, `category`, `condition`, `direction`, `location`,
`assigned_to` (word-start, case-insensitive: "Nick" matches "Nick Smith", not "Dominick"), or a
`filters` object for any field the dataset allows. Links are HMAC-signed with
`MCP_CONFIRMATION_SECRET`, bind the Hermes role so crew-level money redaction still applies,
and need no login, so treat one as a short-lived secret. Signed-in users get the same files
from `GET /api/exports/{dataset}/{xlsx|pdf|csv}` and the app's **Admin > Files & Imports** tab.

`operational_activity(limit?, since?)` is the compact live-context feed for
MobileOps Admin. It returns app dashboard activity, successful typed MCP
mutations, and the corresponding bot audit summaries. Mutable records must
still be resolved through their typed read tools before a write; activity is a
timeline, not a source of truth.

Nathan2 also has focused proactive rental reads: `get_inventory_availability`,
`get_inventory_forecast`, `get_inventory_timeline`, `get_customer_preferences`, `get_active_rentals`,
`get_scheduled_returns`, `get_scheduled_outbounds`, `get_rental_detail`,
`get_equipment_status`, `get_repair_pipeline`, `get_inventory_conflicts`, and
`get_outbound_risk`. Their deterministic forecast contract, reservation
behavior, and approval boundaries are documented in
[Nathan2 rental availability](nathan2-rental-availability.md).

## Documents: Excel, PDF and imports

Implementation: `exports.py` (datasets, XLSX/PDF/CSV renderers), `pdf_documents.py`
(rental agreement, dispatch tickets), `documents.py` (stored files, signed links, audit),
`imports.py` (staged import pipeline). The UI is **Admin > Files & Imports**.

| Tool | Effect | Scope | Confirmation |
|---|---|---|---|
| `export_report` | Excel/PDF/CSV report, stored, signed link | `operations:read` | none |
| `rental_agreement_pdf(rental_id)` | Rental agreement / transaction record PDF | `rentals:read` | none |
| `dispatch_ticket_pdf(dispatch_id)` | Outbound delivery or inbound/return pickup ticket | `dispatch:read` | none |
| `import_create_upload(dataset, on_duplicate?, mapping?)` | Single-use 10-minute upload URL; uploading **stages a preview only** | `equipment:write` (equipment, tools) or `inventory:write` (consumables, block) | none |
| `import_preview(dataset, filename, file_base64, ...)` | Same preview from a small (<=1 MB) inline file | as above | none |
| `import_status(import_id, offset?, limit?, action?)` | Re-read a preview/result | `inventory:read` | none |
| `import_plan_report(import_id)` | Every row of a preview as an Excel file | `inventory:read` | none |
| `import_cancel(import_id)` | Discard a preview | `equipment:write` | none |
| `import_commit(import_id, plan_hash, skip_invalid_rows?)` | Apply a reviewed plan | `equipment:write` (+ `inventory:write` for consumables/block) | **admin grant only** |

Importable datasets: `equipment` (inventory), `tools`, `consumables`, `block`. Rentals,
dispatches and returns are exported but deliberately **not importable**: they drive
reservations and the inventory ledger, so a bulk import would corrupt stock.

### Import flow and guarantees

1. **Stage.** Parse the `.xlsx` (or a table-based `.pdf`), auto-map columns by header
   (override with `mapping`), validate every row, detect duplicates (in the file and against
   MobileOps), and persist a plan with a `plan_hash`. Staging writes only to `import_jobs` /
   `import_files`; it never touches inventory.
2. **Review.** The preview shows counts, per-row errors, the column mapping, ignored columns,
   and old -> new values for any proposed update. `import_plan_report` exports all of it.
3. **Commit.** Requires an admin grant and the exact `plan_hash` that was reviewed. The plan is
   re-derived from live data first; if anything changed the commit is refused (`stale`) and
   nothing is written.

* **No silent overwrite.** Duplicates are skipped by default. `on_duplicate=update` proposes
  field-level updates and still needs the admin commit. Updates never change stock buckets,
  quantity, location, QR/SKU/serial or tracking type; those come from counts, transfers and
  check-in/out, and any such differences are reported as "not applied".
* **All-or-nothing.** Each write records an undo step; any failure rolls every applied write back
  (MongoDB here has no multi-document transactions). A failed rollback sets the job to
  `failed_needs_review` and is logged loudly.
* **Hostile files.** Max 5 MB / 2,000 rows / 60 columns / 40 PDF pages; zip-bomb and macro
  (`vbaProject.bin`) workbooks rejected; formula cells rejected per row (nothing is evaluated);
  exported text beginning with `=` is stored as inert text. PDF import only accepts one
  consistent table, only **adds** records (no updates), and refuses anything it can't extract
  reliably.
* **Initial stock** for created equipment goes through the ledger (`received`, note
  "Initial stock (import ...)"), exactly like `POST /equipment`.
* **Jobs expire** 2 hours after staging; staged jobs are kept 180 days and uploaded files 30 days
  (TTL indexes) as evidence.

### Files, access and audit

Generated files are immutable snapshots in `generated_files` (14-day TTL, <= 12 MB).
Signed-in users download their own files (`/api/files/{id}/download`); admins can download any;
anyone else gets a 404. Signed links (`/api/files/shared/{token}`, `/api/imports/upload/{token}`)
are purpose-bound HMACs, so an upload link can't download and vice versa; upload links are
single use. Responses are `Cache-Control: private, no-store` with `nosniff`.

Every export, PDF, import stage, commit, failure and refusal writes an `operational_activity`
row (`source` = `export` | `import`), and MCP calls additionally write `mcp_audit_log` (with
the approving admin). Inline import payloads are never stored in the audit log, only their
SHA-256 and length. REST routes: `/api/exports/...`, `/api/rentals/{id}/agreement.pdf`,
`/api/dispatches/{id}/ticket.pdf`, `/api/files...`, and admin-only `/api/imports...`.

> New tools reach the Sentinel `mobileops-admin` bot only after MobileOps is deployed and the
> MCP server is refreshed there; per-tool grants then need to be added (reads as `read`,
> `import_commit` as `approval`).

## Verification

An unauthenticated request must return `401`:

```bash
curl -i https://mobileops.example.com/api/mcp/
```

Run the MCP security and adapter tests locally:

```bash
PYTHONPATH=. pytest -q backend/tests/test_mcp_server.py
```

The tests cover endpoint authentication, hashed identity lookup, scope denial,
read/write audit records, exact-parameter confirmation binding, one-time replay
protection, destructive/read-only annotations, and delegation to an existing
MobileOps handler.

## Audit queries

Example Mongo queries:

```javascript
db.mcp_audit_log.find(
  {agent_identity: "hermes-agent"},
  {_id: 0}
).sort({timestamp: -1}).limit(100)

db.mcp_audit_log.find(
  {agent_identity: "hermes-agent", status: "failed"},
  {_id: 0}
).sort({timestamp: -1})
```

Treat this collection as append-only operational evidence. Restrict direct Mongo
write access to the MobileOps backend service and database administrators.
