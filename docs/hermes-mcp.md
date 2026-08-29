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

The additive Mongo collections are `mcp_agents`, `mcp_audit_log`, and
`mcp_confirmations`. Existing collections and API response models are unchanged.

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

For the connected Lisa deployment, the repository contains only the SHA-256
digest in `backend/hermes-agent-token.sha256`; the high-entropy bearer token is
stored only in Lisa's protected `~/.hermes/.env`. A token digest is not a bearer
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

## Connect Hermes

Hermes needs the Python `mcp` package with Streamable HTTP support:

```bash
pip install 'mcp==1.12.4'
```

Add this entry to `~/.hermes/config.yaml`. Keep the URL's trailing slash to avoid
an HTTP redirect. Store the secret in `~/.hermes/.env`, not in YAML.

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

Then restrict the configuration and restart Hermes:

```bash
chmod 600 ~/.hermes/config.yaml
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
| Shop | `shop_tasks_list` | `shop_task_create`, `shop_task_set_status` | `shop_tasks:read/write` |
| Operations | `operational_status` | — | `operations:read` |

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
