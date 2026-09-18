# Touchline AI requirements

This project is designed to run locally on 64-bit Windows 10 or Windows 11. Laragon is optional.

## Required software

- Git for Windows
- Node.js 22.13 or newer
- npm (included with Node.js)
- Python 3.10, 3.11, or 3.12; Python 3.12 is recommended
- PowerShell 5.1 or newer
- Google Cloud CLI for authenticated Video Intelligence and Text-to-Speech access

FFmpeg, FFprobe, tracking environments, model weights, and Node packages are installed by the repository setup scripts. They do not need to be installed globally.

## Cloud services

Use a Google Cloud project with billing enabled and these APIs:

- Vertex AI API
- Video Intelligence API
- Cloud Text-to-Speech API

Create `.env` from `.env.example` and provide at least:

```env
GEMINI_API_KEY=your_key
GOOGLE_CLOUD_PROJECT=your_project_id
```

Never commit `.env`, credentials, downloaded model weights, uploaded videos, rendered outputs, or files under `local-data/` and `work/`.

## Python dependencies

The setup scripts install pinned dependencies from:

- `requirements-tracking.txt` for player, ball, pitch, shot-boundary, and tactical analysis
- `requirements-soccernet.txt` for the optional SoccerNet CALF event spotter

PyTorch is installed separately from the official CPU wheel index by `scripts/setup-tracking.ps1`.

## Recommended hardware

- 16 GB RAM minimum; 32 GB recommended for longer videos
- 20 GB or more free disk space for environments, models, uploads, caches, and renders
- Modern multi-core CPU
- NVIDIA GPU is optional; the default setup works on CPU but tracking and 1080p rendering take longer

## Install on another Windows computer

```powershell
git clone https://github.com/aungmyathtet123/football_highlight.git
cd football_highlight
npm run setup
```

Add the cloud values to `.env`, configure Google credentials, and verify everything:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -SkipNpm -SkipFfmpeg -SkipTracking -ConfigureCloud
npm run setup:verify
npm run test:connections
npm test
npm run test:tracking
```

Start the processor and website:

```powershell
npm run local:start
```

Open <http://localhost:3000>. Stop both services with `npm run local:stop`.

## Current recap behavior

- Complete football actions retain setup, contact, ball movement, and outcome.
- Selected gameplay and reactions render at the source's normal 1.0× speed.
- Original broadcast commentary is muted when generated narration is enabled.
- The final duration expands when needed instead of accelerating or cutting a complete incident.
- Player names and score claims are used only when external match research agrees with the visible incident inventory.

Only use footage you own or have permission to edit. Editing and commentary do not guarantee fair use or prevent copyright claims.
