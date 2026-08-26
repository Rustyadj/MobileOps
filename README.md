# MobileOps

The existing mobile API remains available under `/api`. A separately authenticated
MCP integration for Hermes is mounted at `/api/mcp/`; deployment, security, tool, and
connection instructions are in [docs/hermes-mcp.md](docs/hermes-mcp.md).

## VPS deployment

The production Compose stack builds the Expo web export, serves it through Nginx on
loopback port `3002`, proxies `/api/` to the private FastAPI container, and keeps
MongoDB on an internal Docker network. The VPS Traefik file provider routes
`icfops.srv1427612.hstgr.cloud` to `http://127.0.0.1:3002` and terminates TLS.

```bash
cp .env.production.example .env.production
# Replace every placeholder secret, then:
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build
```

Only port `127.0.0.1:3002` is published. FastAPI and MongoDB are not host-exposed.
