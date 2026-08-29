FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements-prod.txt ./
RUN pip install --no-cache-dir -r requirements-prod.txt

COPY server.py whiteboard_service.py mcp_server.py tool_inventory_seed.csv inbound_plan_seed.json outbound_plan_seed.json hermes-agent-token.sha256 ./

RUN useradd --create-home --uid 10001 mobileops \
    && chown -R mobileops:mobileops /app
USER mobileops

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips=*"]
