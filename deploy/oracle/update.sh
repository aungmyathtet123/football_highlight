#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

git pull --ff-only
npm ci
npm run build
sudo systemctl restart touchline-processor.service touchline-web.service
sudo systemctl --no-pager --full status touchline-processor.service touchline-web.service
