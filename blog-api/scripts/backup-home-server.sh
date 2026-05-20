#!/usr/bin/env bash
# Create a portable backup of the home-server blog data.
#
# Run on vm-public inside /home/sumin/xminblog/blog-api, or locally with:
#   REMOTE=sumin@192.168.45.60 REMOTE_DIR=/home/sumin/xminblog/blog-api blog-api/scripts/backup-home-server.sh
#
# Output contains:
#   - PostgreSQL custom dump (.dump)
#   - uploads tarball (.tar.gz)
#   - manifest with checksums
set -Eeuo pipefail

REMOTE="${REMOTE:-}"
REMOTE_DIR="${REMOTE_DIR:-/home/sumin/xminblog/blog-api}"
KEEP="${KEEP:-14}"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/blog-api-backups}"
UPLOAD_DIR="${UPLOAD_DIR:-data/uploads}"
ENV_FILE="${ENV_FILE:-.env.home}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/$TS"

cleanup_on_error() {
  local code=$?
  if [[ $code -ne 0 && -n "${BACKUP_DIR:-}" && -d "$BACKUP_DIR" ]]; then
    rm -rf "$BACKUP_DIR"
  fi
  exit $code
}

dump_database() {
  local out="$1"
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump --no-owner --no-acl --format=custom --file="$out" "$DATABASE_URL"
    return
  fi
  if command -v docker >/dev/null 2>&1; then
    echo "[backup] pg_dump not found; using postgres:16 docker image" >&2
    docker run --rm --network host -e DATABASE_URL postgres:16 \
      pg_dump --no-owner --no-acl --format=custom "$DATABASE_URL" > "$out"
    return
  fi
  echo "pg_dump not found and docker fallback unavailable" >&2
  return 127
}

run_local() {
  trap cleanup_on_error ERR
  mkdir -p "$BACKUP_DIR"

  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
  fi
  : "${DATABASE_URL:?DATABASE_URL must be set or present in $ENV_FILE}"

  echo "[backup] dumping PostgreSQL → $BACKUP_DIR/blog-api.dump"
  dump_database "$BACKUP_DIR/blog-api.dump"

  if [[ ! -d "$UPLOAD_DIR" && "$UPLOAD_DIR" = /app/data/uploads && -d data/uploads ]]; then
    UPLOAD_DIR=data/uploads
  fi
  echo "[backup] archiving uploads → $BACKUP_DIR/uploads.tar.gz"
  if [[ -d "$UPLOAD_DIR" ]]; then
    tar -C "$(dirname "$UPLOAD_DIR")" -czf "$BACKUP_DIR/uploads.tar.gz" "$(basename "$UPLOAD_DIR")"
  else
    tar -czf "$BACKUP_DIR/uploads.tar.gz" --files-from /dev/null
  fi

  {
    echo "created_at_utc=$TS"
    echo "host=$(hostname)"
    echo "backup_dir=$BACKUP_DIR"
    echo "upload_dir=$UPLOAD_DIR"
    echo "database_url_host=$(node -e 'const u=new URL(process.env.DATABASE_URL); console.log(`${u.hostname}:${u.port||5432}/${u.pathname.slice(1)}`)' 2>/dev/null || echo unknown)"
    command -v sha256sum >/dev/null && sha256sum "$BACKUP_DIR"/* || shasum -a 256 "$BACKUP_DIR"/*
  } > "$BACKUP_DIR/manifest.txt"

  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | head -n "-$KEEP" | xargs -r rm -rf
  echo "[backup] complete: $BACKUP_DIR"
}

if [[ -n "$REMOTE" ]]; then
  echo "[backup] running remotely on $REMOTE:$REMOTE_DIR"
  ssh "$REMOTE" "cd '$REMOTE_DIR' && KEEP='$KEEP' BACKUP_ROOT='$BACKUP_ROOT' UPLOAD_DIR='$UPLOAD_DIR' ENV_FILE='$ENV_FILE' bash -s" < "$0"
else
  run_local
fi
