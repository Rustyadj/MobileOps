#!/bin/zsh

chown -R hermes:hermes /opt/data 2>/dev/null || true

mkdir -p /opt/data/logs
chown hermes:hermes /opt/data/logs

if [[ -f /opt/data/config.yaml ]]; then
  if ! pgrep -f "/opt/hermes/.venv/bin/hermes gateway run" >/dev/null 2>&1; then
    gosu hermes nohup hermes gateway run >>/opt/data/logs/gateway.log 2>&1 </dev/null &
  fi
fi

# Nathan uses his own Telegram bot and profile, but shares Lisa's provider and
# service credentials. Run Telegram in polling mode so the profile cannot
# overwrite or bind Lisa's webhook URL/port inherited from the container.
if [[ -f /opt/data/profiles/nathan/config.yaml ]]; then
  mkdir -p /opt/data/profiles/nathan/logs
  chown hermes:hermes /opt/data/profiles/nathan/logs

  if ! pgrep -f "/opt/hermes/.venv/bin/hermes -p nathan gateway run" >/dev/null 2>&1; then
    (
      export TELEGRAM_WEBHOOK_URL=""
      export TELEGRAM_WEBHOOK_PORT=""
      export TELEGRAM_WEBHOOK_SECRET=""
      gosu hermes nohup hermes -p nathan gateway run \
        >>/opt/data/profiles/nathan/logs/gateway.log 2>&1 </dev/null &
    )
  fi
fi

if [[ -n "${ADMIN_USERNAME:-}" && -n "${ADMIN_PASSWORD:-}" ]]; then
  export HERMES_DASHBOARD_BASIC_AUTH_USERNAME="$ADMIN_USERNAME"
  export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="$ADMIN_PASSWORD"
else
  unset HERMES_DASHBOARD_BASIC_AUTH_USERNAME
  unset HERMES_DASHBOARD_BASIC_AUTH_PASSWORD
fi

gosu hermes nohup hermes dashboard --host 127.0.0.1 --port 4862 --no-open --skip-build --insecure >>/opt/data/logs/dashboard.log 2>&1 </dev/null
