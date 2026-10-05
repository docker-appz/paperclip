#!/usr/bin/env bash
set -euo pipefail

# Determine repository root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Run docker compose logs forwarding any additional arguments (e.g. server, --tail 100)
docker compose --env-file .env -f docker/docker-compose.yml logs -f "$@"
