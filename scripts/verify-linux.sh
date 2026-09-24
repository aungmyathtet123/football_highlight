#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

fail() { echo "ERROR: $*" >&2; exit 1; }
for command in node npm python3 ffmpeg ffprobe curl; do
  command -v "$command" >/dev/null || fail "$command is not installed"
done

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 22 )) || fail "Node.js 22 or newer is required"
[[ -f .env ]] || fail "Missing .env (copy deploy/oracle/env.production.example first)"
[[ -x .venv-tracking/bin/python ]] || fail "Missing tracking environment; run scripts/setup-linux.sh"

set -a
# shellcheck disable=SC1091
source ./.env
set +a

[[ "${SITE_URL:-}" == https://* ]] || fail "SITE_URL must use https:// in production"
[[ "${PUBLIC_BASE_URL:-}" == "${SITE_URL:-}" ]] || fail "PUBLIC_BASE_URL must match SITE_URL"
[[ "${NEXT_PUBLIC_PROCESSOR_URL:-}" == "${SITE_URL:-}" ]] || fail "NEXT_PUBLIC_PROCESSOR_URL must match SITE_URL"
[[ "${LOCAL_DATA_DIR:-}" == /* ]] || fail "LOCAL_DATA_DIR must be an absolute persistent Linux path"
[[ -d "$LOCAL_DATA_DIR" && -w "$LOCAL_DATA_DIR" ]] || fail "$LOCAL_DATA_DIR is not writable"
[[ -n "${GEMINI_API_KEY:-}" ]] || fail "GEMINI_API_KEY is empty"
[[ -n "${GOOGLE_CLOUD_PROJECT:-}" ]] || fail "GOOGLE_CLOUD_PROJECT is empty"
if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  [[ -r "$GOOGLE_APPLICATION_CREDENTIALS" ]] || fail "Google credentials file is not readable"
fi

echo "fb37942448e7de08745e8aab148d0794f680a738ddd55e5f17abe9ab2d6313fb  tools/tracking/yolo-football-ball-detection.pt" | sha256sum --check --status \
  || fail "Football-ball model checksum mismatch"
echo "06623b51f77f51695cde731da146596e6df73c95a5b4776f6afe7094389ed209  tools/tracking/yolo-football-pitch-detection.pt" | sha256sum --check --status \
  || fail "Pitch model checksum mismatch"

.venv-tracking/bin/python -c "import cv2, torch, ultralytics, supervision, lap, scenedetect"
ffmpeg -hide_banner -version | head -n 1
node --version
npm --version
echo "Linux production verification passed."
