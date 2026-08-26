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
- downloads and verifies the local YOLO11n tracking model
- checks every required local component

The first setup downloads several large packages and can take time.

## Add your cloud configuration

The local UI can start after setup, but actual AI processing needs the cloud values below.

Open .env and add:

~~~env
GEMINI_API_KEY=your_new_gemini_api_key
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

The processor reviews the complete source timeline before it chooses clips. It then builds one connected football-analysis story instead of joining unrelated highlights:

1. Rank evidence across the whole match and choose one incident or tactical question.
2. Arrange a hook, setup, evidence, action, proof, and consequence/reaction.
3. Keep every micro-scene between 1.2 and 5 seconds and use speed changes only when they clarify the action.
4. Reject normal-play shots that cannot keep the ball and involved player inside the same 9:16 crop. Celebration and reaction shots are the exception.
5. Track the camera crop, player marker, and ball marker from frame to frame.
6. Render edge-to-edge at exactly 1080 × 1920 with one restrained base grade, event-specific replay/goal treatments, short animated captions, purposeful sound effects, and contextual callouts.
7. Generate one continuous male football-analyst narration track and mute the source commentary.

The default target is 60 seconds. A shorter result is preferred when additional footage would weaken the story or lose the ball/player framing.

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

Only use footage you own or have permission to edit. Editing, cropping, narration, effects, or watermark handling does not automatically make use lawful or qualify it as fair use.
