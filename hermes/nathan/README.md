# Nathan Hermes profile

Nathan is the MobileOps ICF field-operations specialist. The live deployment is
the dedicated `hermes-nathan2` container; its isolated Hermes `default` profile
owns Nathan's workspace, memory, persona, and MobileOps MCP connection.

The tracked files in this directory are the source of truth for Nathan's custom
persona and field-operations skill:

- `SOUL.md` — identity, operating style, safety boundaries, and MobileOps rules.
- `skills/nathan-field-operations/SKILL.md` — proactive field workflows,
  readiness checks, exception handling, and mutation verification.
- `skills/nathan-field-operations/references/mobileops-app-map.md` — stable app
  domains, inventory and job lifecycles, screen coverage, and the boundary
  between product knowledge and live MCP capabilities.

Existing cloned skills such as `icf-takeoff` and `construction/icf-crew` remain
available to the profile.

The tracked `entrypoint-override.sh` hands process supervision to the Hermes s6
image, which keeps the dedicated gateway and dashboard running. Nathan2's
dashboard listens on port `4864`; the private `mobileops-hermes-relay.service`
forwards Docker bridge port `4863` to that loopback service. MobileOps logs in
with the dedicated dashboard service credential and mints a single-use
WebSocket ticket for each invocation.

Current runtime choices:

- Model: `deepseek/deepseek-v4-flash-vision-exp` through OpenRouter.
- Credentials and the MobileOps MCP bearer token live only in Nathan2's
  protected `/opt/data/.env`; no raw secret is committed here.
- Telegram uses the same dedicated Nathan2 gateway. Keep its bot token only in
  the protected `/opt/data/.env` and authorize users through Hermes pairing or
  a numeric `TELEGRAM_ALLOWED_USERS` allowlist.
- The MobileOps dashboard credential must match
  `HERMES_NATHAN_GATEWAY_TOKEN` in MobileOps' protected production env.

Useful runtime commands inside the Hermes container:

```bash
hermes profile list
hermes chat
hermes mcp list
hermes mcp test mobileops
hermes gateway status
```

MobileOps mutations always require the MCP server's two-call human confirmation
flow. Do not weaken that behavior in profile prompts or skills.
