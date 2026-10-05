#!/usr/bin/env bash
set -euo pipefail

# Determine repository root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

COMPOSE_FILE="docker/docker-compose.yml"

echo "==> Stopping containers with docker compose..."
docker compose -f "$COMPOSE_FILE" down "$@"
echo "==> Paperclip stopped successfully."
