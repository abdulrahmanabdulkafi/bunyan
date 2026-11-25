#!/usr/bin/env bash
# Trial run of Bunyan with demo data (GitHub Codespaces, a dev container, or any machine with Node 22 + PostgreSQL 16).
#   bash scripts/trial.sh setup   install, build, create the database and load the demo entities (once)
#   bash scripts/trial.sh start   start the API (:4000) and the web interface (:3000) in the background
#   bash scripts/trial.sh reset   wipe the demo database and load it again
#   bash scripts/trial.sh stop
# Not for production: two-step verification is off and the demo password is public.
set -euo pipefail
cd "$(dirname "$0")/.."
export ADMIN_DATABASE_URL="${ADMIN_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
export DATABASE_URL="${DATABASE_URL:-postgres://bunyan_app:bunyan_app@localhost:5432/bunyan}"
export MFA_REQUIRED_ROLES="${MFA_REQUIRED_ROLES:-none}"
LOG=.trial; mkdir -p "$LOG"

wait_db() {
  for _ in $(seq 1 60); do
    node -e "const c=new (require('pg').Client)(process.env.ADMIN_DATABASE_URL);c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null && return 0
    sleep 1
  done
  echo "PostgreSQL is not reachable at $ADMIN_DATABASE_URL" >&2; exit 1
}

case "${1:-start}" in
  setup)
    npm ci
    npm run build
    wait_db
    node scripts/db-setup.mjs --demo
    ;;
  reset)
    wait_db
    node scripts/db-setup.mjs --demo --reset
    ;;
  start)
    wait_db
    [ -d apps/api/dist ] && [ -d apps/web/.next ] || npm run build
    "$0" stop >/dev/null 2>&1 || true
    nohup npm --workspace apps/api start > "$LOG/api.log" 2>&1 &
    nohup npm --workspace apps/web start > "$LOG/web.log" 2>&1 &
    for _ in $(seq 1 60); do curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && break; sleep 1; done
    if curl -sf http://localhost:3000/api/health >/dev/null; then
      echo ""
      echo "  بُنيان يعمل: http://localhost:3000   (في Codespaces افتح تبويب PORTS ثم المنفذ 3000)"
      echo "  الدخول: ea@a.local  /  Bunyan@2026   — بقية الحسابات في TRY.md"
      echo ""
    else
      echo "Bunyan did not start; see $LOG/api.log and $LOG/web.log" >&2; exit 1
    fi
    ;;
  stop)
    pkill -f "node dist/main.js" || true
    pkill -f "next-server" || true
    pkill -f "next start" || true
    ;;
  *) echo "usage: $0 setup|start|reset|stop" >&2; exit 2 ;;
esac
