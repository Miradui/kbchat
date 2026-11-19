#!/usr/bin/env bash
# Disposable CI project only; never targets the operator's deployment.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
smoke_dir=$(mktemp -d)
export KBCHAT_ENV_FILE="$smoke_dir/runtime.env"
smoke_project="kbchat-smoke-$$"
export COMPOSE_PROJECT_NAME="$smoke_project"
cp deploy/.env.production.example "$KBCHAT_ENV_FILE"
cat >> "$KBCHAT_ENV_FILE" <<VARS
COMPOSE_PROJECT_NAME=$smoke_project
KBCHAT_VERSION=smoke
POSTGRES_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -hex 16)
CHAT_API_KEY=fixture
EMBEDDING_API_KEY=fixture
RERANK_API_KEY=fixture
RERANK_MODEL=fixture
KBCHAT_SUBNET=172.30.82.0/24
KBCHAT_DYNAMIC_RANGE=172.30.82.128/25
KBCHAT_PROXY_IP=172.30.82.2
KBCHAT_PORT=18089
VARS
compose=(docker compose --env-file "$KBCHAT_ENV_FILE" -f deploy/compose.production.yml)
cleanup() {
  [[ "$COMPOSE_PROJECT_NAME" == "$smoke_project" && "$smoke_project" == kbchat-smoke-* ]] || return 1
  "${compose[@]}" logs --no-color --tail 40 || true
  "${compose[@]}" down --volumes --remove-orphans
  # Only files created above, at a fresh private temporary path.
  rm "$KBCHAT_ENV_FILE"
  rmdir "$smoke_dir"
}
trap cleanup EXIT
./deploy/release.sh build
./deploy/release.sh init
if ./deploy/release.sh init > "$smoke_dir/reinit.log" 2>&1; then
  echo "Expected initialization to reject an existing database" >&2
  exit 1
fi
rm "$smoke_dir/reinit.log"
./deploy/release.sh admin smoke-admin
./deploy/release.sh start
python3 - <<'PY'
import json,os,pathlib,urllib.request
config={}
for line in pathlib.Path(os.environ['KBCHAT_ENV_FILE']).read_text().splitlines():
 if '=' in line and not line.startswith('#'):
  k,v=line.split('=',1);config[k]=v
base='http://127.0.0.1:18089'
for route in ['/chat','/documents','/knowledge-bases']:
 with urllib.request.urlopen(base+route,timeout=10) as response:
  assert response.status==200 and b'<div id="root">' in response.read()
with urllib.request.urlopen(base+'/api/v1/healthz',timeout=10) as response:
 assert json.load(response)['status']=='ok'
request=urllib.request.Request(base+'/api/v1/auth/login',data=json.dumps({'username':'smoke-admin','password':config['BOOTSTRAP_ADMIN_PASSWORD']}).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=10) as response:assert json.load(response)['token']
print('Compose readiness, SPA routes and administrator login passed')
PY
./deploy/release.sh stop
./deploy/release.sh start
./deploy/release.sh doctor
