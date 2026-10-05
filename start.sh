#!/usr/bin/env bash
set -euo pipefail

# Determine repository root
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

# Check that Docker daemon is running
if ! docker info >/dev/null 2>&1; then
  echo "==> Error: Docker daemon is not running. Please start Docker / Docker Desktop and try again." >&2
  exit 1
fi

echo "==> 1. Pulling latest code..."
git pull

# 2. Manage persistent environment file (.env)
ENV_FILE=".env"

# Initialize .env from .env.example if missing
if [ ! -f "$ENV_FILE" ]; then
  if [ -f .env.example ]; then
    cp .env.example "$ENV_FILE"
    echo "==> Initialized $ENV_FILE from .env.example"
  else
    touch "$ENV_FILE"
  fi
fi

# Ensure a persistent, secure BETTER_AUTH_SECRET exists in .env
if ! grep -q "^BETTER_AUTH_SECRET=" "$ENV_FILE" 2>/dev/null || grep -q "^BETTER_AUTH_SECRET=paperclip-dev-secret" "$ENV_FILE" 2>/dev/null; then
  GENERATED_SECRET="$(openssl rand -hex 32)"
  if grep -q "^BETTER_AUTH_SECRET=" "$ENV_FILE" 2>/dev/null; then
    awk -v secret="$GENERATED_SECRET" 'BEGIN{FS=OFS="="} /^BETTER_AUTH_SECRET=/{$2=secret} {print}' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "BETTER_AUTH_SECRET=$GENERATED_SECRET" >> "$ENV_FILE"
  fi
  echo "==> Generated and persisted secure BETTER_AUTH_SECRET in $ENV_FILE"
fi

# Ensure POSTGRES_PORT exists in .env (defaults to 5434)
if ! grep -q "^POSTGRES_PORT=" "$ENV_FILE" 2>/dev/null; then
  echo "POSTGRES_PORT=5434" >> "$ENV_FILE"
  echo "==> Added POSTGRES_PORT=5434 to $ENV_FILE"
fi

# Ensure OPENROUTER_API_KEY exists in .env
if ! grep -q "^OPENROUTER_API_KEY=" "$ENV_FILE" 2>/dev/null; then
  echo "OPENROUTER_API_KEY=sk-or-v1-..." >> "$ENV_FILE"
  echo "==> Added OPENROUTER_API_KEY to $ENV_FILE"
fi

# Ensure ZAI_API_KEY exists in .env
if ! grep -q "^ZAI_API_KEY=" "$ENV_FILE" 2>/dev/null; then
  echo "ZAI_API_KEY=" >> "$ENV_FILE"
  echo "==> Added ZAI_API_KEY to $ENV_FILE"
fi

# Ensure ZAI_BASE_URL exists in .env
if ! grep -q "^ZAI_BASE_URL=" "$ENV_FILE" 2>/dev/null; then
  echo "ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4" >> "$ENV_FILE"
  echo "==> Added ZAI_BASE_URL to $ENV_FILE"
fi

# Ensure PAPERCLIP_PUBLIC_URL exists in .env
if ! grep -q "^PAPERCLIP_PUBLIC_URL=" "$ENV_FILE" 2>/dev/null; then
  echo "PAPERCLIP_PUBLIC_URL=https://akira.tail0ddb51.ts.net:3100" >> "$ENV_FILE"
  echo "==> Added PAPERCLIP_PUBLIC_URL to $ENV_FILE"
fi

# Ensure PAPERCLIP_ALLOWED_HOSTNAMES exists in .env
if ! grep -q "^PAPERCLIP_ALLOWED_HOSTNAMES=" "$ENV_FILE" 2>/dev/null; then
  echo "PAPERCLIP_ALLOWED_HOSTNAMES=akira.tail0ddb51.ts.net" >> "$ENV_FILE"
  echo "==> Added PAPERCLIP_ALLOWED_HOSTNAMES to $ENV_FILE"
fi

# Ensure GITHUB_ACCESS_TOKEN exists in .env
if ! grep -q "^GITHUB_ACCESS_TOKEN=" "$ENV_FILE" 2>/dev/null; then
  echo "GITHUB_ACCESS_TOKEN=" >> "$ENV_FILE"
  echo "==> Added GITHUB_ACCESS_TOKEN to $ENV_FILE"
fi

# Update localhost:5432 to localhost:5434 in DATABASE_URL if present from .env.example
if grep -q "^DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip" "$ENV_FILE" 2>/dev/null; then
  awk 'BEGIN{FS=OFS="="} /^DATABASE_URL=/{gsub("localhost:5432", "localhost:5434")} {print}' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
fi

# Load environment variables
set -a
source "$ENV_FILE"
set +a

COMPOSE_FILE="docker/docker-compose.yml"

echo "==> 2. Starting containers with docker compose..."
docker compose -f "$COMPOSE_FILE" up -d --build

echo "==> 3. Following container logs (press Ctrl+C to exit log streaming)..."
docker compose -f "$COMPOSE_FILE" logs -f
