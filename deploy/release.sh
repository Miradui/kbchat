#!/usr/bin/env bash
# Run from any directory. No implicit migrations or volume deletion.
set -euo pipefail
release_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export KBCHAT_ENV_FILE=${KBCHAT_ENV_FILE:-$release_dir/.env.production}
if [[ ! -f "$KBCHAT_ENV_FILE" ]]; then
  echo "Create $KBCHAT_ENV_FILE from deploy/.env.production.example first." >&2
  exit 1
fi
compose=(docker compose --env-file "$KBCHAT_ENV_FILE" -f "$release_dir/compose.production.yml")
# This flag is explicit in the shell so no operator env file is sourced as code.
if [[ "${KBCHAT_OBSERVABILITY:-false}" == true ]]; then
  compose+=(-f "$release_dir/compose.observability.yml" --profile observability)
fi
select_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    checksum=(sha256sum)
  elif command -v shasum >/dev/null 2>&1; then
    checksum=(shasum -a 256)
  else
    echo "Install sha256sum (coreutils) or shasum before backup/restore." >&2
    exit 1
  fi
}
require_stopped() {
  local containers state container
  containers=$("${compose[@]}" ps -a -q backend)
  for container in $containers; do
    state=$(docker inspect --format '{{.State.Status}}' "$container")
    case "$state" in
      exited|created) ;;
      *) echo "Backend is $state; run deploy/release.sh stop before this operation." >&2; exit 1 ;;
    esac
  done
}
empty_database() {
  local tables
  tables=$("${compose[@]}" exec -T postgres psql -U kbchat -d kbchat -XAt -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
  [[ "$tables" == 0 ]] || { echo "Database is not empty; use explicit migrate for an upgrade." >&2; exit 1; }
}
case "${1:-status}" in
  build) "${compose[@]}" build --pull backend frontend ;;
  init)
    require_stopped
    "${compose[@]}" up -d --wait postgres redis
    empty_database
    # Only a brand-new empty database may adopt a non-default dimension.
    dimension=$("${compose[@]}" run --rm --no-deps backend sh -c 'printf "%s" "${EMBEDDING_DIMENSION:-1536}"')
    [[ "$dimension" =~ ^[0-9]+$ ]] && ((dimension >= 1 && dimension <= 2000)) || { echo "Embedding dimension must be 1..2000" >&2; exit 1; }
    "${compose[@]}" run --rm --no-deps backend /app/bin/rag-migrate
    if [[ "$dimension" != 1536 ]]; then
      "${compose[@]}" exec -T postgres psql -U kbchat -d kbchat -X -v ON_ERROR_STOP=1 -c "BEGIN; LOCK TABLE document_chunks IN ACCESS EXCLUSIVE MODE; DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM document_chunks) THEN RAISE EXCEPTION 'expected empty chunks'; END IF; END \$\$; DROP INDEX IF EXISTS idx_chunks_embedding_hnsw; ALTER TABLE document_chunks ALTER COLUMN embedding TYPE vector($dimension); CREATE INDEX idx_chunks_embedding_hnsw ON document_chunks USING hnsw (embedding vector_cosine_ops) WITH (m=16,ef_construction=64); COMMIT;"
    fi
    "${compose[@]}" run --rm --no-deps backend /app/bin/rag-doctor
    ;;
  admin)
    [[ $# == 2 ]] || { echo "Usage: $0 admin USERNAME" >&2; exit 2; }
    "${compose[@]}" run --rm --no-deps backend /app/bin/rag-bootstrap-admin -username "$2" -create
    ;;
  migrate)
    [[ $# == 2 && "$2" == *.sql && "$2" != */* ]] || { echo "Usage: $0 migrate EXACT_FILENAME.sql" >&2; exit 2; }
    require_stopped
    "${compose[@]}" run --rm --no-deps backend /app/bin/rag-migrate -migration "$2" -timeout 30m
    ;;
  start) "${compose[@]}" up -d --wait --wait-timeout 120 ;;
  stop) "${compose[@]}" stop frontend backend ;;
  status) "${compose[@]}" ps ;;
  doctor) "${compose[@]}" run --rm --no-deps backend /app/bin/rag-doctor ;;
  backup)
    [[ $# == 2 && ! -e "$2" ]] || { echo "Usage: $0 backup NEW_DIRECTORY" >&2; exit 2; }
    select_checksum
    require_stopped
    provider=$("${compose[@]}" run --rm --no-deps backend sh -c 'printf "%s" "${STORAGE_PROVIDER:-local}"')
    [[ "$provider" == local ]] || { echo "For MinIO, use the coordinated database/object backup procedure in docs/13-deployment.md." >&2; exit 1; }
    umask 077
    mkdir -p "$2"
    "${compose[@]}" exec -T postgres pg_dump -U kbchat -d kbchat -Fc > "$2/database.dump"
    "${compose[@]}" exec -T postgres pg_restore --list < "$2/database.dump" > "$2/database-contents.txt"
    "${compose[@]}" run --rm --no-deps -T backend tar -C /app/uploads -czf - . > "$2/uploads.tar.gz"
    cp "$KBCHAT_ENV_FILE" "$2/environment.env"
    cp "$release_dir/compose.production.yml" "$2/compose.production.yml"
    "${compose[@]}" images --format json > "$2/images.json"
    (cd "$2" && "${checksum[@]}" database.dump uploads.tar.gz environment.env compose.production.yml > SHA256SUMS)
    echo "Backup complete; backend remains stopped. Store the environment backup securely."
    ;;
  restore)
    [[ $# == 2 && -f "$2/SHA256SUMS" ]] || { echo "Usage: $0 restore BACKUP_DIRECTORY (empty isolated target only)" >&2; exit 2; }
    select_checksum
    require_stopped
    (cd "$2" && "${checksum[@]}" -c SHA256SUMS)
    "${compose[@]}" up -d --wait postgres redis
    empty_database
    "${compose[@]}" run --rm --no-deps backend sh -c 'test -z "$(find /app/uploads -mindepth 1 -print -quit)"'
    "${compose[@]}" exec -T postgres pg_restore -U kbchat -d kbchat --no-owner --no-acl --exit-on-error < "$2/database.dump"
    "${compose[@]}" run --rm --no-deps -T backend tar -C /app/uploads -xzf - < "$2/uploads.tar.gz"
    "${compose[@]}" run --rm --no-deps backend /app/bin/rag-doctor
    echo "Restored; backend remains stopped. Verify with the matching image version."
    ;;
  *) echo "Usage: $0 {build|init|admin USERNAME|migrate FILE.sql|start|stop|status|doctor|backup NEW_DIR|restore BACKUP_DIR}" >&2; exit 2 ;;
esac
