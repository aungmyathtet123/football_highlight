# Touchline AI

Touchline AI turns football footage into one short vertical MP4. The web interface runs through the local Laragon domain and a separate local processor keeps uploads, job metadata, tracking data, and rendered files on this computer.

## What works

- local MP4, MOV, or WebM upload (up to 2 GB)
- FFprobe inspection and FFmpeg 1080×1920 MP4 rendering
- local-only persistent file storage under `local-data/`
- Gemini Enterprise Agent Platform video analysis through a backend-only API key
- Google Cloud Video Intelligence shot boundaries and tracked-object evidence through ADC
- a bounded, compressed local analysis proxy for Vertex inline-video requests
- Google Cloud Text-to-Speech commentary through Application Default Credentials
- configurable Gemini and TTS model, language, and voice
- local YOLO11 player/ball detection with smoothed, interpolated camera keyframes
- a tracked active-player ring and narration-only audio when AI commentary is enabled
- persistent embedded logo/watermark masking when Gemini detects a high-confidence overlay
- burned-in commentary captions, result preview, MP4 download, and JSON edit plan

## Environment

The private `.env` contains the runtime values and is excluded from Git. `.env.example` contains the safe template.

```env
VIDEO_ANALYSIS_PROVIDER=gemini
VIDEO_INTELLIGENCE_ENABLED=true
VIDEO_INTELLIGENCE_LOCATION=us-east1
VIDEO_INTELLIGENCE_FEATURES=SHOT_CHANGE_DETECTION,OBJECT_TRACKING
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.7-flash

TRACKING_PYTHON=./.venv-tracking/Scripts/python.exe
TRACKING_MODEL=./tools/tracking/yolo11n.pt
TRACKING_SAMPLE_FPS=5
TRACKING_IMAGE_SIZE=960
TRACKING_CONFIDENCE=0.08

GOOGLE_CLOUD_PROJECT=football-506506
GOOGLE_CLOUD_LOCATION=global

TTS_PROVIDER=google_cloud
TTS_MODEL=gemini-2.5-flash-tts
TTS_LANGUAGE=en-US
TTS_VOICE=Kore
```

Never put `GEMINI_API_KEY` in a `NEXT_PUBLIC_` variable. Google Cloud TTS uses ADC and does not use `TTS_API_KEY`.

## Google Cloud setup

Install the Google Cloud CLI, then authenticate locally:

```powershell
gcloud init
gcloud auth application-default login
gcloud auth application-default set-quota-project football-506506
```

The Google Cloud project must have billing and these APIs enabled:

- Agent Platform API for Gemini
- Video Intelligence API (`videointelligence.googleapis.com`)
- Cloud Text-to-Speech API (`texttospeech.googleapis.com`)

For production, use an ADC-compatible workload or service identity. Do not store service-account JSON keys in this repository.

## Local tracking setup

Install the project-local CPU tracking runtime and official YOLO11n model once:

```powershell
npm run setup:tracking
```

The runtime is stored under `.venv-tracking/` and the model under `tools/tracking/`; both are excluded from Git. Tracking runs locally. The detector samples selected highlight moments, follows the ball when visible, falls back to the nearest active player during short occlusions, smooths the camera path, and interpolates motion on every rendered frame.
## Connection tests

Run each provider separately before processing personal footage:

```powershell
npm run test:gemini
npm run test:gemini-video
npm run test:video-intelligence
npm run test:tts
```

The TTS test generates `work/google-cloud-tts-test.wav` using this text:

> What a finish. The striker finds the space and makes no mistake.

Run all checks in order with:

```powershell
npm run test:connections
```

No test prints API keys or access tokens. Unsupported configured model or voice values produce a clear error and are never silently replaced.

## Run locally

Open two terminals in this project:

```powershell
npm run processor
```

```powershell
npm run dev
```

Then open `http://football_highlight.test`. Keep both terminals open while processing.

Health check: `http://127.0.0.1:8787/health`

## Private local data

```text
local-data/
  uploads/<job-id>/source.*
  jobs/<job-id>.json
  outputs/<job-id>/analysis/video-proxy.mp4
  outputs/<job-id>/tracking/tracking.json
  outputs/<job-id>/tracking/player-ring.png
  outputs/<job-id>/speech/*.wav
  outputs/<job-id>/final.mp4
```

Source, tracking, and output files remain on local disk. When cloud analysis is enabled, each compressed analysis proxy is sent inline to Video Intelligence and Gemini; no Cloud Storage bucket is required. Video Intelligence supplies shot boundaries and general tracked-object coordinates, Gemini makes the semantic edit decisions, and local YOLO remains responsible for precise football/player tracking in selected moments. Commentary text is sent to Cloud Text-to-Speech when narration is enabled. With AI commentary enabled, the source audio is not connected to the final render; only the generated narration track is used.

Only upload footage you own or have permission to use. Enable logo/watermark masking only for overlays you are authorized to alter.
