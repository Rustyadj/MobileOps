# Nathan Hermes profile

Nathan is the MobileOps ICF field-operations specialist. The live profile is
installed as `nathan` under Hermes and cloned from the active profile so it has
an isolated workspace and memory while retaining the configured MobileOps MCP
connection.

The tracked files in this directory are the source of truth for Nathan's custom
persona and field-operations skill:

- `SOUL.md` — identity, operating style, safety boundaries, and MobileOps rules.
- `skills/nathan-field-operations/SKILL.md` — proactive field workflows,
  readiness checks, exception handling, and mutation verification.

Existing cloned skills such as `icf-takeoff` and `construction/icf-crew` remain
available to the profile.

The tracked `entrypoint-override.sh` starts both Lisa's default gateway and
Nathan's profile gateway. Nathan's Telegram adapter is forced into polling mode
so it does not compete with Lisa's webhook listener. Nathan's profile explicitly
disables the cloned SMS adapter while retaining the shared provider and service
credentials.

Current runtime choices:

- Model: `deepseek/deepseek-v4-flash-vision-exp` through OpenRouter.
- Telegram: a profile-specific bot token stored only in Nathan's protected
  `.env`; the token is never committed here.
- Access: Lisa's existing Telegram user allowlist is retained for Nathan.
- Credentials: Lisa's provider/API keys are cloned into Nathan. The Twilio
  Account SID is retained under an inactive `LISA_SHARED_` variable because
  Hermes v0.18.0 otherwise auto-enables the SMS adapter despite an explicit
  platform disable.

Useful runtime commands inside the Hermes container:

```bash
hermes profile show nathan
hermes -p nathan chat
hermes -p nathan mcp list
hermes -p nathan mcp test mobileops
hermes -p nathan gateway status
```

MobileOps mutations always require the MCP server's two-call human confirmation
flow. Do not weaken that behavior in profile prompts or skills.
