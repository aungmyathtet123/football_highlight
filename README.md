# Touchline AI

Touchline AI analyzes football footage and renders narrated 1920 × 1080 MP4 recaps. The web app, processor, uploads, tracking data, and outputs run locally on your computer. Gemini, Google Video Intelligence, and Google Cloud Text-to-Speech are the cloud services.

For a concise installation checklist, hardware guidance, cloud requirements, and copy-to-another-computer instructions, see [REQUIREMENTS.md](REQUIREMENTS.md).

## Complete incident coverage and tactical drawings

New planning checks require every distinct semantically verified goal and offside/disallowed-goal/VAR incident in the supplied footage. Replays share the original incident ID rather than counting as extra goals. Thirty seconds is a minimum, not an early stopping point. `incident-coverage.json` reports any verified incident that local tracking could not preserve; the editor does not silently omit it. A scoreboard alone does not establish that missing goals exist in the upload.

Gemini can request `tacticalDrawing` of `pass`, `ball`, `run`, or `map` on an analytical freeze. Passing arrows require both players in the same frame and sustained observed receiver possession. Ball and run paths require direct observations and validated camera registration. Pitch-map insets use mplsoccer 1.8.0 and a local pitch-keypoint model with held-out landmark checks. They are approximate, never official offside measurements. The renderer skips uncertain or action-obscuring graphics and records why in `tactical/report.json`.

`npm run setup:tracking` installs mplsoccer and the checksum-pinned [AGPL-3.0 pitch model](https://huggingface.co/martinjolif/yolo-football-pitch-detection). `TRACKING_PITCH_MODEL` overrides its local path. No extra API key is required for these local drawings. Current real-footage tests have exercised the omission paths for uncertain trajectories and pitch calibration; a successful all-goals annotated end-to-end export still requires visual verification. The previously approved export is unchanged.

## Hybrid football event discovery

Complete-match recaps use the official [SoccerNet CALF action spotter](https://github.com/SoccerNet/sn-spotting) before Gemini scene analysis. CALF scans the complete upload at 2 fps and proposes timestamps for 17 football event classes. These labels are search proposals, not narration facts: Gemini verifies the visible action and may correct a class before it enters the edit. PySceneDetect supplies camera boundaries, and one complete action may span several consecutive broadcast shots. Local player/ball tracking and FFmpeg remain the final authority for portrait framing and rendering.

Run `npm run setup:soccernet` to create the isolated Python 3.10 environment and clone the Apache-2.0 CALF implementation with its pretrained benchmark weights. The adapter handles CALF's Linux symlink and GPU-only assumptions on Windows/CPU without modifying the official checkout. The first run downloads ResNet152 weights and takes several minutes on CPU; later model downloads are cached. Per-job normalized proposals are saved as `soccernet-calf.json`.
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
- creates an isolated .venv-soccernet and installs the official pretrained SoccerNet CALF action spotter
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

## How duration-aware edits are built

New edits use **AI-selected natural length, with a 60-second minimum for complete recaps**. There is no duration selector or fixed 65/75/85-second target. After the whole source is observed and tracking is verified, Gemini selects the strongest complete incidents and their natural length before writing narration. This estimate guides the script, not a fixed deadline. Automatic edits do not add ending padding or synthetic replay merely to reach the estimate.

The processor follows an evidence-first sequence before writing content:

1. **Observe:** Gemini reviews the complete source timeline from beginning to end in timing-keyed 180-second excerpts and records complete 5–12-second actions. It prioritizes confirmed goals, shots on target, saves, shots, and big chances. Each goal is requested as one shared story ID containing the live finish, immediate celebration, and replay proof. Transient Gemini 503/504 responses are retried once.
2. **Verify and track:** Review complete incidents, then sample gameplay locally at 10 frames per second. Verify the initiating player and ball at contact, ball flight, and the actual result inside the portrait crop. Smooth camera paths must also pass stability checks. A bounded higher-detail repair targets near-complete observations; it does not invent missing action. Reactions are eligible only after their own action passes. Saved observations are reused on retry.
3. **Choose and write:** Gemini chooses verified scene IDs and a natural story length of at least 60 seconds for complete recaps. A separate writer receives the exact verified scene-slot count and creates the exact number of narration beats that can be shown. When verified goal evidence exists, the script explains how that goal was created and finished before using lower-priority incidents. Directing filler such as “look at the replay,” “watch this,” or “as you can see” fails validation.
4. **Align:** A separate evidence editor maps every approved content beat exactly once to a verified complete-action scene. A goal cluster must remain contiguous: scorer and ball, decisive contact, flight, goalmouth result, then the same goal’s celebration and/or replay. An unrelated post-goal cut fails before rendering. Camera evidence must match the selected source interval; reuse of a candidate ID alone is insufficient.
5. **Edit:** Concise male analysis leaves quiet gaps for action; source commentary stays muted. An eligible opening action gets a 0.8-second payoff teaser, followed by its complete buildup. Captions are separate 2–4-word headlines, not sliced narration: white with one yellow emphasis word, dark outline, restrained motion, and no added text over celebrations. Reactions stay at normal speed for at most 3 seconds. Markers and contact freezes are optional analytical tools; no automatic badge/effect stack or decorative punch zoom. Long speech must be rewritten instead of extending a frozen ending. Two-pass audio normalization targets −15 LUFS and measures the finished mix.
6. **Validate:** A separate draft audit rejects unverified player/team names and scorelines; use player roles until identities are independently verified. FFprobe verifies the real MP4 dimensions, streams, and the 60-second complete-recap minimum. Final Gemini review must provide scene-by-scene visible-action and spoken-claim evidence, not scores alone. Missing review, identity claims, mismatched narration, and caption overload block approval alongside framing and continuity failures.

The processor refuses to create unsupported analysis when content alignment or tracking cannot provide at least 60 seconds of complete evidence. It does not relax ball/player visibility or camera stability checks. Saved legacy jobs retain their previous explicit duration policy. The downloadable JSON includes the approved content plan, aligned moments, per-scene tracking brief, tracking quality evidence, synchronization data, and final review.

Retries are exclusive per job: another analysis or render retry receives HTTP 409 while that video is queued or processing. Once a run finishes, saved evidence can be reused. Alignment keeps the verified scene order, including silent goal celebrations; it does not sort supporting footage independently by narration beat. `alignment-review.json` records the proposed scenes and sequence checks for diagnosis before rendering.

The reusable project skill is stored at [.agents/skills/football-video-editor/SKILL.md](.agents/skills/football-video-editor/SKILL.md). Its edit contract is also enforced by the runtime Gemini prompts.
If you intentionally use Laragon and football_highlight.test, set this in the private .env:

~~~env
SITE_URL=http://football_highlight.test
~~~

Keep NEXT_PUBLIC_PROCESSOR_URL=http://127.0.0.1:8787.

## Runtime configuration

The safe defaults are documented in .env.example. Important local paths are:

~~~env
SOCCERNET_CALF_ENABLED=true
SOCCERNET_CALF_PYTHON=./.venv-soccernet/Scripts/python.exe
SOCCERNET_CALF_REPO=./tools/external/soccernet-sn-spotting
TRACKING_PYTHON=./.venv-tracking/Scripts/python.exe
TRACKING_MODEL=./tools/tracking/yolo11n.pt
TRACKING_BALL_MODEL=./tools/tracking/yolo-football-ball-detection.pt
TRACKING_SAMPLE_FPS=10
ANALYSIS_FPS=3
ANALYSIS_HEIGHT=480
FFMPEG_PATH=./tools/ffmpeg/bin/ffmpeg.exe
FFPROBE_PATH=./tools/ffmpeg/bin/ffprobe.exe
~~~

Generated and private files are excluded from Git:

~~~text
.env
node_modules/
.venv-tracking/
.venv-soccernet/
tools/external/soccernet-sn-spotting/
tools/ffmpeg/
tools/tracking/*.pt
local-data/
work/
~~~

Local source files and rendered outputs stay under local-data/. When cloud analysis is enabled, compressed analysis media and related metadata are sent to the configured Google services.

Ball tracking uses the [martinjolif football-ball YOLO11n model](https://huggingface.co/martinjolif/yolo-football-ball-detection), licensed AGPL-3.0. The application keeps that downloaded weight outside Git and uses it locally.

Tracking version 34 uses Supervision 0.30.2 tiled ball detection and Ultralytics BoT-SORT with sparse optical-flow camera compensation. `npm run setup:tracking` installs the pinned dependencies, including PySceneDetect 0.7.1, LAP 0.5.12 and SciPy 1.15.3. No additional API key is required for local tracking. Selective detail searches cost extra CPU time; they do not guarantee perfect detection.

The portrait camera keeps the involved player/ball pair together, then prioritizes the travelling ball when the original passer cannot fit. It reacquires after occlusion instead of stopping the search, uses whole-shot acceleration minimization with actual sample intervals, and evaluates crop coordinates on the source clock before slow motion or freezes. FFmpeg retains every tracking sample without extra stop/start easing. Old caches and caches with changed scene boundaries or camera briefs are invalidated.

Short detection gaps use interpolation between two observed endpoints within 0.45 seconds and cannot cross a source cut. They remain marked as predictions and cannot force hard crop-containment constraints. A receiver repeatedly closer to the observed ball can take ownership even when the old player has a strong tracking preference. Source interval matching prevents a reused candidate ID from attaching camera evidence from different seconds.

Detector comparison on 2026-09-05: the installed ball detector produced boot-like false positives in the supplied shot sequence. A separately downloaded [football role detector](https://huggingface.co/mobadam/football-player-detection) found no ball candidates at source seconds 42.4, 42.8, 43.2 and 43.6 with 1280-pixel inference and a 0.03 confidence threshold. It is not enabled in production. This four-frame comparison does not establish general detector accuracy; the saved diagnostics explain why a package swap alone was not accepted as a fix. The optional benchmark weight stays outside Git.

Gemini editing contract version 8 requires explicit visible payoff times and a source-frame result region. Goal/shot captions, outcome sound accents, goal color changes and payoff teasers require that region and a continuously observed ball inside the final crop. Estimated scene percentages and predicted ball coordinates cannot trigger them. Unverified outcome effects are omitted; they are never replaced with guessed scoring claims.

Run `npm run test:tracking` for camera regressions and `node scripts/benchmark-tracking.mjs <completed-job-id>` for an isolated three-scene local test. The benchmark uses no paid analysis/TTS calls, writes under `work/`, and never overwrites completed videos. Visual inspection remains required, especially for airborne balls, camera cuts and occlusions.

Visible scoring regions are verified before tracking and constrain the payoff crop. Region constraints are applied before offline ball-path association, so alternative observed candidates remain available. Airborne shots are allowed above the grass; missing observations remain missing. A verified goal-area hold is not reported as a ball detection. A bounded Gemini recheck examines result rectangles wider than the actual portrait crop. It may return uncertainty rather than invent a smaller rectangle. `scripts/verify-benchmark-payoffs.mjs` is a separate opt-in paid Gemini check of an existing labeled test proxy.

For complete recaps, the processor first turns every PySceneDetect boundary into a full-video shot ledger. Gemini audits that ledger once, including useful buildup and ordinary attacking passages, before any expensive tracking. A duration-buffered primary selection always includes every detected goal and decision incident; ranked reserves are tracked only when verified footage is still below the requested duration. The incident pipeline then verifies goals with their matching replays and reactions before writing the story. PySceneDetect identifies real source cuts. Raw detections are saved per source frame in SQLite and complete scene results are checkpointed using source/model/settings signatures. Retrying preserves the full observed incident inventory, not just a previous edit's selected scenes. The UI reports detection and camera planning separately. At most two higher-detail local repair attempts and two additional discovery passes run per job revision.

Goal checks measure the actual 9:16 crop separately at setup, contact, flight and payoff. The initiating player must be visible with the ball at contact; after release, ball flight and the result replace the old passer as the camera's required subjects. Predicted coordinates cannot count as direct ball observations. Failed checkpoints and exact rejection reasons remain available for inspection. A cached semantic approval cannot undo a newer local framing rejection.

For an isolated pipeline test with configured Gemini/TTS services, run `node scripts/run-pipeline-regression.mjs <source-job-id> [observation-job-id]`. The optional observation job is accepted only when both source files have identical SHA-256 hashes. This resumes saved whole-video observations; it is not a fresh-upload analysis test. Results stay under `work/pipeline-regression-*`. Use `scripts/inspect-tracking.py` to compare source frames with measured crop bounds; green circles are direct detections and red circles are predictions in this diagnostic only.

Only use footage you own or have permission to edit. Editing, cropping, narration, effects, or watermark handling does not automatically make use lawful or qualify it as fair use.
