# Touchline AI

Touchline AI analyzes football footage and renders narrated 1920 × 1080 MP4 recaps. The web app, processor, uploads, tracking data, and outputs run locally on your computer. Gemini, Google Video Intelligence, and Google Cloud Text-to-Speech are the cloud services.

The source screen supports resumable file uploads and authorized YouTube-link imports. A link import runs as a separate background job, is validated and stored privately, and stops at **Ready to edit**. Gemini analysis starts only after the user previews that source and clicks **Analyze & edit**. Only import videos you own, have licensed, or are otherwise legally authorized to use; this is not an official YouTube API download feature.

For a concise installation checklist, hardware guidance, cloud requirements, and copy-to-another-computer instructions, see [REQUIREMENTS.md](REQUIREMENTS.md).

## Complete incident coverage and tactical drawings

New planning checks require every distinct semantically verified goal and offside/disallowed-goal/VAR incident in the supplied footage. Replays share the original incident ID rather than counting as extra goals. Complete recaps require at least 60 seconds of complete action, planned before tracking; more footage is discovered in Step 1 when needed. `incident-coverage.json` reports any verified incident that tracking could not preserve; the editor does not silently omit it. A scoreboard alone does not establish that missing goals exist in the upload.

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

Football vision is configured for `gemini-3.1-pro-preview` on the `global`
endpoint. The local paid test uses Priority PayGo, but `.env.example` keeps
standard traffic unless you explicitly enable the higher-priced priority tier.
Check the response traffic type: a priority request is not proof that Google
served it as priority. Critical video observations request high media detail;
keyframe observations use compact batches and bounded structured responses.
Inventory and semantic caches record model provenance so a model change does
not reuse an older model's mistaken scene classifications.

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

Open [http://127.0.0.1:3002](http://127.0.0.1:3002). Port 3002 is the local default. Override it with `LOCAL_WEB_PORT` in `.env` or your shell environment. The launcher refuses an occupied port if it does not serve Touchline AI; it never stops the other application. Restart the local processor after changing the port so its allowed browser origins update too.

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

New complete recaps use **a 60-second minimum planned before tracking**, with a natural evidence-led length above that. Each overlapping source section receives one initial Gemini video analysis. Local code reconciles the resulting metadata; it does not combine scene videos. Selection keeps match chronology, complete goals and meaningful chances. No ending padding or synthetic replay is added to reach the minimum.

The processor follows an evidence-first sequence before writing content:

1. **Observe once:** Gemini watches each complete source section and returns all useful distinct actions, exact natural boundaries, camera-shot IDs, setup/contact/continuation/result times and explicit source descriptions. Prefer one clear complete live angle per incident; use a complete replay only when needed. No routine second inventory, scoreboard-image audit, semantic review reel, goal search or duration search runs for complete recaps. Provider 429/5xx/timeouts retry the same request and preserve completed sections.
2. **Validate, split and lock locally:** Validate the initial response clocks and visible-action declarations; deduplicate overlap and repeated incident angles, balance flexible section budgets, and preserve every observed goal. Save each selected original-ratio scene separately and lock its exact interval in `fixed-scene-queue.json`. An initial source observation is explicitly labelled as such, not an independent second opinion or verified portrait crop. Invalid source evidence cannot be padded or force-approved.
3. **Track:** Save separate muted original-frame clips, then process the locked scenes one at a time with independent scene-local clocks. Gemini observes native player/ball positions; deterministic camera calculations build a stable 9:16 path. Independently review the actual crop. Repair that scene's camera without changing its boundaries, returning to discovery, substituting a replay or dropping it. Save each completed path and separate portrait asset.
4. **Edit and review:** Preserve every locked scene at normal 1x speed. Apply evidence-linked captions, freezes, tracked rings, tactical lines, grades and transitions. Save the exact reviewed visual timeline, including effect and transition timing. A duration guide cannot truncate this list.
5. **Watch, write and record last:** Finish the complete muted visual edit first. Gemini watches that entire video once and writes an engaging basic-English recap against its actual rendered scene clock, with verified player names only. Record normal-speed voice in those windows; only an overlong section gets shorter wording and another take. Do not rewrite the whole recap for a global word-count estimate, change the visual scenes, accelerate speech or pad the story. Approved scripts, finished pictures and measured voice sections survive retries. Add narration subtitles and voice to the existing visual master for the final export.
6. **Validate:** Check actual MP4 dimensions, streams, scene continuity, ball/player visibility, camera stability, captions and audible claims. A finished-video review is required before calling a test successful; unit tests and a diagnostic crop alone do not certify the export.

The live progress UI shows the selected scene count, exact source intervals,
separate-clip save count and verified camera count. Every scene has an individual
waiting/tracking/repairing/verified status. Source selection, camera tracking,
effect planning, recap writing, voice recording, rendering and final checks are
separate steps driven by saved job evidence—not by an estimated percentage.
Switching projects cancels the old polling loop. Gemini capacity waits retry
automatically; unfinished browser uploads still require the browser to upload
the remaining bytes.

The processor counts only unique, complete source action toward the 60-second complete-recap minimum. Section results, including empty sections, are checkpointed with source/model/contract provenance before local interpretation. Routine correction calls are disabled for the initial response. Unusable evidence is recorded, not accepted using invented phase times. All selection decisions finish before locking; tracking never promotes reserves, removes chances or returns to source discovery. Ball/player visibility and actual-crop stability checks remain mandatory.

Legacy non-complete-recap workflows retain independent source/outcome review helpers. These are not called by the new complete-recap Step 1. Initial video evidence and later portrait-crop verification have separate provenance; uncertain outcomes are never cached as approvals.

Source semantic verification version 15 records a structured physical outcome in the same independent pixel review. A complete, consistent observation can supply the outcome check without another identical video request. Reuse requires exact source/model provenance, unchanged source boundaries, valid in-scene action phases and a verified payoff; discovery labels, ambiguous outcomes and missing evidence cannot use this shortcut. The later rendered-portrait review remains independent.

Outcome conflict handling works in both directions: a claimed goal against an unchanged live score, and a miss/save against its own score-increase incident. A contradiction triggers one saved, focused adjudication with uncropped contact/result images, native score context and up to two distinct already-discovered matching action angles. Supporting angles never supply the primary scene's coordinates or replace its boundaries. Score increases cannot automatically approve goals; unresolved evidence remains explicitly unapproved. A completed adjudication is not repeated unchanged on every retry.

`KEYFRAME_PROVIDER` defaults to `gemini`, including when an existing environment has no setting. `hybrid` and `local` are explicit opt-ins, not silent defaults. Gemini supplies visual observations; deterministic camera-path calculations smooth those observations rather than guessing ball/player positions. The isolated test harness inherits the configured provider unless an explicit diagnostic override or saved test provider is supplied.

Step 1 counts actions approved from the initial structured section observation without requiring tracking that has not run yet. Missing draft confidence, incomplete phases or invalid clocks are not silently coerced into approval. The initial response never supplies a passing portrait camera path: Step 2 observes each saved clip independently.

Overlapping discovery chunks cannot count the same observed shot twice just because their story IDs or scene boundaries differ. Step 1 reconciles independently verified contact/result clocks inside overlapping source intervals before locking the scene list. Different contacts, later replay footage and uncertain draft geometry are not merged by this rule. Clear-angle workflow version 9 rebuilds an older selection from its saved source observations; it does not repeat whole-video discovery or discard completed coordinate caches.

Shot alignment and action-origin trimming never change an already locked scene's source interval or clear its semantic approval. Origin refinement happens before Step-1 selection is locked; retrying a narration or tracking stage must reuse that exact reviewed interval and its approved camera path. A selection-policy upgrade loads the original Step-1 manifest rather than a partially mutated tracking payload, and explicitly exits stale tracking-only retry state before reconciling that saved selection. Later narration retries still prefer the completed visual timeline without reselection.

When sampled Gemini positions produce an impossible pan or unresolved visibility gap, the tracker first reobserves a bounded set of the exact uncertain native source images with the complete same-scene video as context. It retains the other observations and saves that correction separately. No box is interpolated or invented to fix the failure: the corrected observations must still pass the camera constraints and an independent review of the actual crop.

Focused visual repair also supplies a magnified native-pixel search region alongside each full source image; it is a visual aid, never a ball detection or a camera command. All returned boxes remain in full-source coordinates. A short body/leg occlusion can be accepted only with explicit source-model evidence, directly seen same-shot entry and exit, an in-crop observed corridor, and a separate actual-crop occlusion check. A ball lost before the sporting consequence remains a failure. Conversely, a visibly resolved wide/over shot or parry does not require watching the ball into the stands or waiting for the next possession to finish. Scene-level verified/repair counts are checkpointed and displayed while the queue runs.

Accepted outcomes also require unchanged scoreboard and referee-decision context. A readable score just inside the scene setup is context, not an automatic rejection. A claimed allowed goal conflicting with a stable live score triggers a bounded higher-reasoning reobservation of the original action; unresolved conflict cannot approve a scoring claim. Crop review distinguishes gameplay, disciplinary decisions and support reactions, rather than requiring shot flight during referee/celebration close-ups. Each completed scene's tracking is checkpointed before its parallel siblings finish, so a failed sibling does not discard successful keyframes.

Crop visibility is independent of scoring: a clearly visible, complete save or miss is not a framing failure simply because the ball did not enter the goal. Contradictory reviews get a fresh, focused observation of the actual crop rather than changing a negative verdict in code or repeating camera-coordinate repair unnecessarily. Typed outcome evidence may correct one non-goal event to another before narration; it cannot discard an awarded goal, approve an unseen payoff, or claim a keeper save without visible keeper contact.

Gemini first observes a complete source-action phase timeline, then coordinate batches receive a short neighbouring source-video window with an explicit scene-local clock, rather than repeating the entire scene for every batch. The phase timeline supplies no coordinates or crop approval. Repair images retain up to 1920 pixels of source width without upscaling smaller uploads. A directly observed nearby goalkeeper can constrain the receiving/payoff crop and requires an independent keeper-context visibility check; a distant keeper cannot pull setup away from the carrier. At payoff the keeper remains a constraint when the ball and keeper still fit together, even as the scored ball moves across the net. A visually rejected scene remains locked and unapproved while later scenes finish their independent checks and save their keyframes; infrastructure errors still stop the worker. Reserve promotion does not repeat unchanged rejected scenes within the same run; an explicit later tracking retry can repair them. Native evidence from a different source interval cannot verify another scene. Only a positively reviewed crop may refine an impossible pre-touch waiting prefix, preserving the initiating contact and the complete result. A tight pre-contact close-up followed by a genuine source cut may instead start at the clear shot, but a separate whole-original-scene audit must verify the same carrier, no removed pass/shot and complete setup-to-payoff before portrait QA. Free-form crop-review names are not identity evidence and cannot be promoted into corrected-outcome narration.

The isolated local harness supports `--analysis-model=MODEL` and `--keyframe-model=MODEL` for comparative testing without changing `.env` or the production model. A model's successful API response is not a passed video test: inspect the actual exported crop, narration and complete goal coverage before deploying.

Gemini crop repairs reuse validated observation batches from the same source/model/scene/version and sampling clock even when the repair wording changes. These cached observations are hypotheses, not approval: focused native-source reobservation and independent actual-crop review still apply. A rejected crop reports missing visibility flags and outcome evidence, including when its model issue list is empty. At a shot's result, a directly observed relevant upright/crossbar corner can constrain the crop alongside the ball and keeper so wide/over/side-netting remain distinguishable; no goalpost coordinates are inferred from a presumed result. Post-action reactions in a continuous non-goal shot retain the directly observed involved keeper rather than jumping to a distant teammate. The source consequence must be visibly resolved before ball-free reaction footage is accepted.

Actual-crop reviews may supply timestamped setup/contact/payoff evidence in `phaseChecks` instead of repeating it in a second `observations` prose table. Missing duplicate prose alone is not a framing failure; positive visibility/outcome flags and independent crop approval are still required. Goal-kick decision support after an observed completed chance is not missing gameplay. An unexplained ball loss before the consequence still fails verification.

After a non-goal result is already observed, explicitly observed resolved/out-of-play state may hold the involved keeper instead of following a dead ball into the stands. Unknown state, playable rebounds and goal-line action cannot use this support rule. A geometrically readable crop with a disputed result gets one focused independent source/crop comparison, cached by the actual rendered bytes and camera plan; the original reference cannot approve action hidden in the portrait. Negative visibility flags are never changed programmatically.

Voice timing rewrites calibrate the word budget from the configured voice's actual recorded words/seconds, and use that same budget in the writer prompt and validation. They do not repeat the generic estimate, cut locked scenes or change their 1x playback. Basic-English and visual-evidence instructions are retained on every correction request. Measured timing feedback is saved in `speech/timing-feedback.json` for inspection.

Render-only retries compare the saved measured voice against the actual locked visual duration, not an earlier target-duration guide or a fixed word-count guess. They reuse exact approved source/crop evidence before invoking the tracker; only missing, changed-interval, wrong-provider or unapproved scenes are retracked. Portrait recap header cleanup covers the entire shallow broadcast-header strip in output coordinates, without changing the camera path. Its centered display pairs the verified team images with the final score; full team names stay in metadata, not the burned-in header. Unknown results are never invented. Full recaps use clean cuts instead of full-frame white/black flashes that can obscure the next action's opening.

The portrait result header uses a heavily blurred copy of the footage with a light dark tint for text legibility, not a solid blue background. It does not resize, recrop or retime the main action. Team images first use FotMob's public team-page index, then an exact full page-identity check (including men's/women's distinctions). PNG bytes and provenance are cached per job. A failed lookup tries packaged reviewed official-federation symbols and then exact-name ESPN competition data; it does not stop after one missing FotMob image. Official symbols are currently bundled for Germany and the Netherlands, and secondary league lookup covers the common international and club competitions listed in `team-badges.mjs`. No arbitrary Google image hit is trusted as identity evidence. Any still-unresolved identity is recorded in `team-badges/resolution.json`; no wrong logo is invented. Refresh the index with `node scripts/sync-fotmob-team-catalog.mjs` and reviewed official assets with `node scripts/sync-official-team-symbols.mjs` (requires the development `sharp` package). The runtime worker needs only the prepared PNGs. Logos/symbols remain identification marks, not a grant of footage rights.

The video header displays only **team image — final score — team image** as one centered group; team-name text is not burned into it. Full team names remain in job/title metadata. Badge ordering and score ordering always agree, including non-draw results. Recaps do not add a footer bar or a "Football Analysis" footer label. The channel watermark remains separate. A final export review can receive `--score-reference=original-score.jpg` to independently check the spoken result from original scoreboard pixels when broadcast graphics are deliberately covered in the edit. Reference footage is never counted as edited goal/crop evidence.

For Windows AV1 uploads, `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-fast-ffmpeg.ps1` installs a separate full FFmpeg build with the dav1d decoder, verifying the publisher's SHA-256 checksum. Set `FFMPEG_PATH=./tools/ffmpeg-full/bin/ffmpeg.exe` and `FFPROBE_PATH=./tools/ffmpeg-full/bin/ffprobe.exe` for new workers. The script neither overwrites the existing build nor restarts running jobs. Decoder acceleration changes processing cost, not playback speed, scene timing or source resolution.

Broadcast-cut checkpoints store exact file-size/nanosecond metadata as strings across Python/JavaScript. Older numeric timestamps are read from their original JSON digits using Node 22's parser context, not a rounded Number. This prevents repeated whole-source cut detection for an unchanged upload while still rejecting changed sources or detector versions. A small, timing-preserving spatial cut-analysis proxy is available only through `shot-boundaries.py --spatial-proxy` for benchmarking; it is not the production default because its end-to-end speed advantage has not been established. It never supplies tracking coordinates or final-render footage.

Verified extra-action reserves may include a completed pass, assist or dribble even when an initial shot label was corrected to normal play. They still require independent semantic approval, visible carrier/ball setup, contact and completed payoff, valid phase times and evidence-linked narration facts. Complete-recap capacity counts the same maximum seven seconds of each genuinely available support reaction that its edit planner permits, never nonexistent source, duplicated reactions or ending padding. Locked, unapproved framing scenes remain selected and appear in the evidence report's repair count. Independently approved actual-crop phase observations can correct stale contact/payoff estimates before effects and narration without changing the scene boundaries or camera coordinates.

Among equally clear, complete single-camera angles, prefer the original earlier buildup to a later replay rather than letting a tiny draft-confidence difference choose the replay. A genuinely clearer or independently verified alternate angle may still win. This ranking happens in Step 1, before selection is locked or portrait tracking starts.

Retries are exclusive per job: another analysis or render retry receives HTTP 409 while that video is queued or processing. Pre-lock retries resume from the saved passage inventory and revalidate stale semantic decisions; only jobs that already passed Step 1 restore the immutable locked-scene manifest. Gemini 429, 408, 502, 503, 504, deadline, socket, and fetch failures save progress and retry persistently with visible backoff state. Alignment keeps the verified scene order, including silent goal celebrations.

The reusable project skill is stored at [.agents/skills/football-video-editor/SKILL.md](.agents/skills/football-video-editor/SKILL.md). Its edit contract is also enforced by the runtime Gemini prompts.
If you intentionally use Laragon and football_highlight.test, set this in the private .env:

~~~env
SITE_URL=http://football_highlight.test
~~~

Keep NEXT_PUBLIC_PROCESSOR_URL=http://127.0.0.1:8787.

## Runtime configuration

The safe defaults are documented in .env.example. Important local paths are:

~~~env
GEMINI_MODEL=gemini-3.1-pro-preview
GEMINI_DISCOVERY_MODEL=gemini-3.8-flash
GEMINI_SCRIPT_MODEL=gemini-3.8-flash
SOCCERNET_CALF_ENABLED=true
SOCCERNET_CALF_PYTHON=./.venv-soccernet/Scripts/python.exe
SOCCERNET_CALF_REPO=./tools/external/soccernet-sn-spotting
TRACKING_PYTHON=./.venv-tracking/Scripts/python.exe
TRACKING_MODEL=./tools/tracking/yolo11n.pt
TRACKING_BALL_MODEL=./tools/tracking/yolo-football-ball-detection.pt
TRACKING_SAMPLE_FPS=10
ANALYSIS_FPS=3
GEMINI_DISCOVERY_FPS=2
ANALYSIS_HEIGHT=480
FFMPEG_PATH=./tools/ffmpeg/bin/ffmpeg.exe
FFPROBE_PATH=./tools/ffmpeg/bin/ffprobe.exe
YTDLP_PATH=./.venv-tracking/Scripts/yt-dlp.exe
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

Gemini semantic verification version 9 uses compact labeled evidence reels, an explicit clip manifest, and exact response-ID completeness checks. It requires explicit visible payoff times and a source-frame result region. Goal/shot captions, outcome sound accents, goal color changes and payoff teasers require that region and continuously observed evidence. Unverified outcome effects are omitted; they are never replaced with guessed scoring claims.

Run `npm run test:tracking` for camera regressions and `node scripts/benchmark-tracking.mjs <completed-job-id>` for an isolated three-scene local test. The benchmark uses no paid analysis/TTS calls, writes under `work/`, and never overwrites completed videos. Visual inspection remains required, especially for airborne balls, camera cuts and occlusions.

Visible scoring regions are verified before tracking and constrain the payoff crop. Region constraints are applied before offline ball-path association, so alternative observed candidates remain available. Airborne shots are allowed above the grass; missing observations remain missing. A verified goal-area hold is not reported as a ball detection. A bounded Gemini recheck examines result rectangles wider than the actual portrait crop. It may return uncertainty rather than invent a smaller rectangle. `scripts/verify-benchmark-payoffs.mjs` is a separate opt-in paid Gemini check of an existing labeled test proxy.

For complete recaps, PySceneDetect indexes source camera cuts and Gemini watches each section once to select complete actions. Source clips remain separate until final rendering. Completed section responses and individual scene camera paths survive retries. The UI distinguishes source-observed actions, saved original clips and verified portrait cameras. No additional discovery pass is run after selection.

Goal checks measure the actual 9:16 crop separately at setup, contact, flight and payoff. The initiating player must be visible with the ball at contact; after release, ball flight and the result replace the old passer as the camera's required subjects. Predicted coordinates cannot count as direct ball observations. Failed checkpoints and exact rejection reasons remain available for inspection. A cached semantic approval cannot undo a newer local framing rejection.

Camera ownership is situation-specific: control, passing and receiving require the observed involved player; a goalkeeper touch uses the separately observed goalkeeper. Travel, rebounds, loose balls and resolved results do not require an unrelated outfield player merely because its box is present. A directly observed resolved result can retain its involved goalkeeper through a following reaction even when the coarse phase label is `continuation`. Missing-ball, incomplete-action and actual-crop review checks remain enforced. These policies apply to every upload; they do not authorize guessed coordinates or automatic approval of unseen goals. `tests/goalkeeper-framing.test.mjs` covers the role transitions, negative cases and checkpoint reuse in the standard test command.

Actual-crop review policy 5 uses a review-only scene clock and asks for every meaningful contact through the last resolved attacking action, including follow-up shots after a live rebound. The clean final render does not include this clock. All meaningful receiving touches must be checked, not only the final shooter. Failure diagnostics use the same effective requirements as the acceptance gate and explicitly identify an unconfirmed source/crop outcome. Crop review starts with LOW thinking and a 16384-token output ceiling because reasoning and JSON share the ceiling; the old MEDIUM/8192 combination could truncate the verdict and require another video call. Rejected-review cache keys include the prompt, schema and generation policy. Approved evidence and initial source observations remain reusable. `tests/crop-review-contract.test.mjs` covers follow-up goals, missing receivers, outcome disagreement, generation budget and review cache reuse.

A concrete sporting-result disagreement receives one paired original-source/actual-crop video comparison. It changes neither scene boundaries nor camera coordinates. A goal correction requires same-action confirmation, visible crossing in both videos and matching scene clocks; source-only action cannot approve a cropped-out consequence. The paired observation is saved separately from the initial hypotheses. Both successful and rejected comparisons are checkpointed, so an unchanged Resume does not pay for the same semantic comparison again. Normal scenes do not use this additional call.

Windows batch rendering measures each encoded part before combining scene clocks. Small encoding tails are assigned to the last scene of their own batch rather than accumulating an estimated-time error at the narration handoff. Substantial duration changes, missing scenes and reordered cuts still fail verification. The combined synchronization checkpoint contains all scenes, not only the last rendered batch. Regression coverage is in `tests/rendered-batch-clock.test.mjs` and `tests/completed-video-narration.test.mjs`.

For an isolated pipeline test with configured Gemini/TTS services, run `node scripts/run-pipeline-regression.mjs <source-job-id> [observation-job-id]`. The optional observation job is accepted only when both source files have identical SHA-256 hashes. This resumes saved whole-video observations; it is not a fresh-upload analysis test. Results stay under `work/pipeline-regression-*`. Use `scripts/inspect-tracking.py` to compare source frames with measured crop bounds; green circles are direct detections and red circles are predictions in this diagnostic only.

Only use footage you own or have permission to edit. Editing, cropping, narration, effects, or watermark handling does not automatically make use lawful or qualify it as fair use.
