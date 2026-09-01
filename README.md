# Touchline AI

Touchline AI analyzes football footage and renders short 1080 × 1920 MP4 edits. The web app, processor, uploads, tracking data, and outputs run locally on your computer. Gemini, Google Video Intelligence, and Google Cloud Text-to-Speech are the cloud services.

## Set up a new Windows computer

Install these prerequisites first:

- Windows 10 or 11, 64-bit
- [Git for Windows](https://git-scm.com/download/win)
- [Node.js](https://nodejs.org/) 22.13 or newer
- [Python](https://www.python.org/downloads/windows/) 3.10, 3.11, or 3.12; Python 3.12 is recommended. Select **Add python.exe to PATH** during installation.
- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) if you want Gemini analysis, Video Intelligence, and Google Cloud TTS

Laragon is optional. The portable default is http://localhost:3000, so no custom Windows hosts entry or Laragon domain is required.

Clone the project:

~~~powershell
git clone git@github.com:aungmyathtet123/football_highlight.git
cd football_highlight
~~~

If that computer does not have a GitHub SSH key, clone with HTTPS instead:

~~~powershell
git clone https://github.com/aungmyathtet123/football_highlight.git
cd football_highlight
~~~

Now double-click **SETUP-WINDOWS.cmd**, or run:

~~~powershell
npm run setup
~~~

The setup is safe to run again. It:

- creates the private .env file from .env.example without overwriting an existing one
- installs the exact Node packages from package-lock.json
- downloads a stable Windows FFmpeg build and verifies its published SHA-256 checksum
- installs FFmpeg and FFprobe locally under tools/ffmpeg/bin
- creates .venv-tracking
- installs CPU PyTorch and the pinned packages in requirements-tracking.txt
- downloads the YOLO11n player detector and the football-specific ball detector, then verifies the ball-model SHA-256 checksum
- checks every required local component

The first setup downloads several large packages and can take time.

## Add your cloud configuration

The local UI can start after setup, but actual AI processing needs the cloud values below.

Open .env and add:

~~~env
GEMINI_API_KEY=replace-me
GOOGLE_CLOUD_PROJECT=your_google_cloud_project_id
~~~

Do not add quotes and never put the key in a NEXT_PUBLIC_ variable. .env is excluded from Git.

Install Google Cloud CLI, ensure billing is active for the project, then let the setup enable the required APIs and create Application Default Credentials:

~~~powershell
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -SkipNpm -SkipFfmpeg -SkipTracking -ConfigureCloud
~~~

This command uses the project ID and Gemini key already in .env. If either is empty, it prompts for it; API-key input is hidden. A browser opens for Google login. It enables:

- Vertex AI API: aiplatform.googleapis.com
- Video Intelligence API: videointelligence.googleapis.com
- Cloud Text-to-Speech API: texttospeech.googleapis.com

Google Cloud TTS uses Application Default Credentials. It does not need an OpenAI key or TTS_API_KEY.

## Start and stop

Start both the local processor and website:

~~~powershell
npm run local:start
~~~

Open [http://localhost:3000](http://localhost:3000).

Stop both services:

~~~powershell
npm run local:stop
~~~

Logs are stored under work/run/. To verify another computer without starting the app:

~~~powershell
npm run setup:verify
~~~

To test the configured cloud providers:

~~~powershell
npm run test:connections
~~~

## Manual development mode

You can still run each service in its own terminal:

~~~powershell
npm run processor
~~~

~~~powershell
npm run dev
~~~

The processor health endpoint is [http://127.0.0.1:8787/health](http://127.0.0.1:8787/health).

## How the 60-second edit is built

The processor follows a strict content-first sequence:

1. **Observe:** Gemini reviews the complete source timeline from beginning to end and records usable and unusable football evidence. It does not choose the final edit yet.
2. **Write:** A separate writer creates an approved 120–147-word football-analysis script with a hook, analytical question, connected reasoning, evidence, and conclusion. Directing filler such as “look at the replay,” “watch this,” or “as you can see” fails validation.
3. **Align:** A separate evidence editor maps every approved content beat to 1.2–5-second source clips. The planned visual timeline must be approximately 60–63 seconds and may connect several related incidents under one clear thesis.
4. **Track:** Local frame-by-frame tracking validates that gameplay keeps the ball and involved player together. Recoverable planned scenes remain in the plan; tracking cannot silently collapse the edit into a short video.
5. **Edit:** The renderer creates one continuous male analyst narration track, mutes the source commentary, dynamically reframes to full-bleed 1080 × 1920, and adds purposeful player/ball markers, captions, replay treatment, effects, sound accents, callouts, and restrained grading.

The processor refuses to complete when content alignment or tracking would reduce a 60-second plan below 51 seconds. The downloadable JSON includes both the approved content plan and the aligned moments.
If you intentionally use Laragon and football_highlight.test, set this in the private .env:

~~~env
SITE_URL=http://football_highlight.test
~~~

Keep NEXT_PUBLIC_PROCESSOR_URL=http://127.0.0.1:8787.

## Runtime configuration

The safe defaults are documented in .env.example. Important local paths are:

~~~env
TRACKING_PYTHON=./.venv-tracking/Scripts/python.exe
TRACKING_MODEL=./tools/tracking/yolo11n.pt
TRACKING_BALL_MODEL=./tools/tracking/yolo-football-ball-detection.pt
FFMPEG_PATH=./tools/ffmpeg/bin/ffmpeg.exe
FFPROBE_PATH=./tools/ffmpeg/bin/ffprobe.exe
~~~

Generated and private files are excluded from Git:

~~~text
.env
node_modules/
.venv-tracking/
tools/ffmpeg/
tools/tracking/*.pt
local-data/
work/
~~~

Local source files and rendered outputs stay under local-data/. When cloud analysis is enabled, compressed analysis media and related metadata are sent to the configured Google services.

Ball tracking uses the [martinjolif football-ball YOLO11n model](https://huggingface.co/martinjolif/yolo-football-ball-detection), licensed AGPL-3.0. The application keeps that downloaded weight outside Git and uses it locally.

Only use footage you own or have permission to edit. Editing, cropping, narration, effects, or watermark handling does not automatically make use lawful or qualify it as fair use.
