#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRACKING_VENV="$PROJECT_ROOT/.venv-tracking"
MODEL_DIR="$PROJECT_ROOT/tools/tracking"
BALL_MODEL="$MODEL_DIR/yolo-football-ball-detection.pt"
PITCH_MODEL="$MODEL_DIR/yolo-football-pitch-detection.pt"
BALL_SHA="fb37942448e7de08745e8aab148d0794f680a738ddd55e5f17abe9ab2d6313fb"
PITCH_SHA="06623b51f77f51695cde731da146596e6df73c95a5b4776f6afe7094389ed209"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer is for Ubuntu Linux." >&2
  exit 1
fi

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "Installing Ubuntu system packages..."
$SUDO apt-get update
$SUDO apt-get install -y ca-certificates curl ffmpeg fonts-dejavu-core git gnupg jq \
  build-essential pkg-config python3 python3-dev python3-pip python3-venv \
  libgl1 libglib2.0-0

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if (( NODE_MAJOR < 22 )); then
  echo "Installing Node.js 22 from the signed NodeSource repository..."
  $SUDO install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y nodejs
fi

echo "Installing locked Node dependencies..."
cd "$PROJECT_ROOT"
npm ci

if [[ ! -x "$TRACKING_VENV/bin/python" ]]; then
  python3 -m venv "$TRACKING_VENV"
fi
PYTHON="$TRACKING_VENV/bin/python"
"$PYTHON" -m pip install --disable-pip-version-check --upgrade pip wheel setuptools

ARCH="$(uname -m)"
if [[ "$ARCH" == "x86_64" ]]; then
  "$PYTHON" -m pip install --disable-pip-version-check \
    torch==2.13.0 torchvision==0.28.0 --index-url https://download.pytorch.org/whl/cpu
elif [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
  # PyPI publishes Linux aarch64 wheels; the PyTorch CPU index is x86-focused.
  "$PYTHON" -m pip install --disable-pip-version-check torch==2.13.0 torchvision==0.28.0
else
  echo "Unsupported CPU architecture: $ARCH" >&2
  exit 1
fi
"$PYTHON" -m pip install --disable-pip-version-check -r "$PROJECT_ROOT/requirements-tracking.txt"

mkdir -p "$MODEL_DIR"
download_verified() {
  local url="$1" destination="$2" expected="$3" temporary="${2}.download"
  if [[ -f "$destination" ]] && echo "$expected  $destination" | sha256sum --check --status; then
    return
  fi
  rm -f -- "$temporary"
  curl --fail --location --retry 4 --retry-delay 5 "$url" --output "$temporary"
  echo "$expected  $temporary" | sha256sum --check --status || {
    rm -f -- "$temporary"
    echo "Checksum verification failed for $destination" >&2
    exit 1
  }
  mv -- "$temporary" "$destination"
}

download_verified \
  "https://huggingface.co/martinjolif/yolo-football-ball-detection/resolve/main/yolo-football-ball-detection.pt?download=true" \
  "$BALL_MODEL" "$BALL_SHA"
download_verified \
  "https://huggingface.co/martinjolif/yolo-football-pitch-detection/resolve/7e4e358d66715b1231260bf4a9ce68c542e04213/yolo-football-pitch-detection.pt?download=true" \
  "$PITCH_MODEL" "$PITCH_SHA"

(
  cd "$MODEL_DIR"
  "$PYTHON" -c "from ultralytics import YOLO; YOLO('yolo11n.pt'); YOLO('yolo-football-ball-detection.pt'); YOLO('yolo-football-pitch-detection.pt')"
)

"$PYTHON" -c "import cv2, torch, ultralytics, supervision, lap, scenedetect; print('Tracking imports ready:', torch.__version__, ultralytics.__version__)"

echo
echo "Linux dependencies and verified football models are ready."
echo "SoccerNet CALF is intentionally disabled on ARM; it is optional and Gemini remains the event-discovery provider."
echo "Next: copy deploy/oracle/env.production.example to .env and run deploy/oracle/install.sh."
