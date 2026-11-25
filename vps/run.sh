#!/usr/bin/env bash
set -e
[ -f .env ] || { cp .env.example .env; echo "Edit .env first, then re-run."; exit 1; }
docker compose up -d --build
docker compose ps
echo "Logs: docker compose logs -f engine"
