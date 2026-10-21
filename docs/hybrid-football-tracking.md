# Hybrid football tracking

Keep story understanding and coordinate measurement separate. Gemini identifies
complete actions and writes basic-English analysis. A broadcast-specific detector
measures the football, player, referee and goalkeeper. A deterministic camera
planner uses those measurements, rather than sparse language-model coordinates.

The selected detector is `mobadam/football-player-detection`, release
`a004ab8edffed6d80758e652fcae683881c7185d`, file `player_detector.pt`.
SHA-256: `05ee5d6c1ed37d92b0425a4d98cbb656bd71869860615590dbfaaae913d75087f`.
Run `npm run setup:tracking` to verify/install it. Model class zero is **ball**,
not person; the pipeline resolves classes by name instead of assuming COCO IDs.
The same loaded detector can provide both ball and people in one forward pass.
Enable the local experiment with `KEYFRAME_PROVIDER=hybrid` and
`HYBRID_TRACKING_MODEL=./tools/tracking/football-role-detector.pt`. The deployed
default remains unchanged until the complete visual regression passes.

Source: https://huggingface.co/mobadam/football-player-detection
The model card lists Apache-2.0, but its checkpoint and the Ultralytics runtime
include AGPL notices. Resolve licensing obligations before commercial deployment;
the model-card label alone is not a commercial-license assurance.

## Regression review

`node tests/qa-hybrid-tracking.mjs <source.mp4> <new-output-directory>` produces
isolated, muted portrait camera diagnostics and filmstrips. These are **not**
approved narrated recap exports. Inspect the starting ball/carrier, release,
flight, keeper/receiver and result, not just numerical coverage. A ball-shaped
boot can otherwise produce misleadingly high tracking metrics.

Do not reuse evidence from a different tracking provider. Model/source/config
fingerprints invalidate detection caches; no blanket cache deletion is needed.
Preserve selected scene boundaries during camera repair. Do not invent coordinates
for an unseen football or mark a missed chance as a scored goal.

Native role detections initialize bounded magnified searches for a tiny carrier
and a recently observed moving ball. Weak proposals guide only an inference ROI,
not the crop or player marker. Original detector observations remain separate
from interpolation. Headers use an observed head envelope rather than assuming
every touch happens at a player's feet. Referees cannot own a gameplay highlight.

`node tests/qa-review-hybrid.mjs <source.mp4> <diagnostic-directory> <scene-id>`
independently reviews the actual crop with Gemini. An absent detector response is
unknown, not proof of a missing ball. Unknown phases require timestamped visual
evidence in the rendered crop. A known off-screen measured ball or excessive
within-shot camera speed cannot be overridden by model approval.

The five-scene muted render-only diagnostic took 130 seconds after enabling
per-scene source seeking. This excludes tracking, narration and model calls;
it is **not** an end-to-end production-time promise.

Status: the initial local detector regression is complete but has not passed
full visual acceptance; the hybrid provider is not yet
enabled in production. CPU inference speed and rendered-crop correctness must
both pass review before deployment. These changes do not guarantee copyright
clearance or freedom from Content ID claims.

## 2026-10-01 local result

- Build passed; 303 JavaScript tests and 78 Python tests passed.
- Five native scene diagnostics were rendered and inspected, not a complete
  narrated recap. The difficult corner/header crop's maximum sampled horizontal
  step improved from 0.4927 to 0.0220 of source width after bounded reacquisition.
- A live independent crop review used verified `ON_DEMAND_PRIORITY` traffic.
  It accepted camera stability but rejected the opening subject and visible
  ball/contact/outcome continuity. This is **not an approved final video**.
- The selected whole broadcast shot includes waiting before the corner taker
  becomes involved. The source also has a weak airborne-ball interval. Step 1
  observation now explicitly distinguishes meaningful origin from shot start;
  locked Step 2 boundaries are not silently shortened to hide the failure.
- Hybrid mode remains opt-in/local. No production deployment or YouTube upload
  was performed. The source fixture still needs a complete passing visual and
  narrated end-to-end run before it can be called production-ready.

## Follow-up: weak ball and cross-to-finish timing

Weak joint-model responses no longer bypass native detail inference. Up to two
current native proposals receive a bounded 384-pixel magnified search; weak
tile detections can receive this check in the same frame. Scores are actual
model outputs, never promoted heuristically. The lossless source frame at 32s
recovered the visible ball with approximately 0.59 confidence after its tiled
response was approximately 0.08. This is a single-frame result, not final-video
acceptance. Detection cache version 10 invalidates the older observations.

`contactTime` still identifies the final scoring touch. `flightStartTime` can
precede it when an assist or cross comes first. Normalization no longer clamps
the cross release to the later header. Native phases follow the cross, observe
the later receiving contact, then follow the finish; the selected scene is not
shortened during tracking. Skill version 15 and semantic version 13 invalidate
older timing approvals.

The camera solver now treats a source shot as one continuous motion problem;
ownership changes are containment changes, not camera cuts. During ball flight,
centering is a soft preference and safe edge visibility stays mandatory. A
nearby player cannot retain carrier ownership merely by being close to an
airborne ball without observed possession.

The actual crop review includes a motion preview plus high-detail stills of
that SAME crop. A strict object schema prevents an unexpected array wrapper
from becoming a cached validation error. The observer reports both initial
release and final receiving contact. Payoff estimates allow one 8fps preview
sample of timestamp quantization; an initial cross cannot replace evidence of
the final header.

The corrected local corner/header diagnostic passed measured safe-crop and
speed checks, then independent priority Gemini review (`hybrid_crop_verified`).
Gemini directly observed the opening corner, cross, receiving header, and ball
entering the net. This demonstrates the physical action, not whether the goal
was officially allowed; the fixture is a disallowed incident and must not be
counted as an awarded goal in narration.

Build, all 308 JavaScript tests and 85 Python tests passed. The latest cached
scene-only tracking/render rerun took about 37 seconds, excluding initial
inference and the paid visual review; it is not an end-to-end timing guarantee.
Diagnostic: `work/hybrid-detail-header-20261001/header.mp4`. Full representative
regression, complete narrated export and production deployment remain pending.

## Fresh narrated end-to-end test findings

The isolated fresh upload is `04f7ce4a-c2fb-423c-9122-004f0bb1cd15` under
`work/local-e2e-1790842334196`. It uses hybrid tracking explicitly; the earlier
harness hard-coded the Gemini provider despite the hybrid fixture changes.

The full test exposed additional pipeline problems before rendering:

- Unbounded FFmpeg decoder/filter threads slowed simultaneous AV1 proxies.
  The shared thread-budget helper now bounds each input and encoder separately.
- Some semantic responses used concatenated-reel timestamps rather than
  candidate-local timestamps. Conversion now requires unambiguous clock
  evidence, including all timestamps fitting the candidate's reel interval;
  mixed or ambiguous clocks are not guessed. New review clips print a reset
  `LOCAL` PTS clock beside the exact candidate identifier.
- Recovery included rejected optional shots even with sufficient capacity.
  It now searches only actual missing goal/decision coverage unless duration
  coverage is deficient. A later replay's 45-second look-back could miss the
  live setup; goal recovery uses 90 seconds and includes later decision context.
- Completed recovery windows previously remained only in memory until the
  entire recovery pass finished. Each matching model/source/prompt/window
  response is now checkpointed independently before the next request.
- Final QA used a 360p/default-detail preview. It now uses 720p HIGH-detail
  video and a less compressed narration preview. Export styling is unchanged.

- The installed Gen AI SDK uses per-attempt deadlines and defaults to five
  internal attempts. The previous outer `Promise.race` did not cancel it.
  The durable scheduler now sets one SDK attempt and passes an AbortSignal;
  its deadline aborts unfinished SDK work before another queued call starts.
  Tests exercise cancellation ordering and timer cleanup after success.

- Two network failures occurred near 304 seconds even with a 360-second
  request deadline. Gemini dispatch now explicitly sets bounded transport
  header/body timeouts beyond the maximum caller deadline, rather than relying
  on the SDK's private-Symbol workaround. Non-Gemini app requests are delegated
  unchanged, and caller cancellation still imposes shorter deadlines.
- Long video requests start with a 360-600 second server deadline. The SDK
  sends `X-Server-Timeout`; repeating an initial 180-second server cutoff
  otherwise discards expensive provider work before it can complete.

All 323 JavaScript regressions passed after the isolated-clock repair below;
85 Python tracking regressions passed earlier in this test. The application
build passed. This does not claim a completed narrated export, production
readiness or deployment.

### Full-test QA rejection (2026-10-01)

The fresh test reached locked-scene tracking, but it did not pass editorial QA.
Independent original-source scoreboard sampling is saved in
`work/local-e2e-1790842334196/scoreboard-audit/audit.json` and its native JPEGs.
The source changes from 0-0 to 0-1 around source 100 seconds; the locked scene
list omits that live goal. Two later proposed goals at source 224-247 seconds
occur while the scoreboard remains 0-1. The source ultimately shows 1-1.
An earlier temporary 1-0 is reversed to 0-0; it cannot be counted as an awarded
goal. A scoreboard supports discovery/decision context, not ball-contact proof.

Actual portrait-crop reviews also rejected unresolved ball movement and
incorrect action timing. Some neutral semantic outputs had out-of-range phase
clocks; normalization clamped every phase to the scene end. Semantic validation
now checks local phase bounds before normalization and reobserves only an
invalid/missing scene as an isolated original-source clip with a reset local
clock. Matching raw cached responses are checked as well. Unit tests cover
invalid, collapsed, valid local and unambiguous reel-clock observations.

The isolated full test was stopped with its evidence/checkpoints preserved,
not accepted as a final recap. There is no verified final MP4 for this run.
The source-selection omission and false goal classifications remain unresolved;
they require a source-wide score/incident cross-check before Step 1 locks scenes,
not a tracking-stage return to discovery or hard-coded fixture timestamps.
Hybrid mode remains local/opt-in. No deployment or publishing was performed.

## Compact scene guidance experiment (2026-10-08)

With `KEYFRAME_PROVIDER=hybrid` and `FAST_TRACKING_ENABLED=true`, new complete
recap jobs run the compact original-video observation before scene selection is
locked. A small original-video context margin permits the selected action to
include its observed completion, rather than discovering a cutoff in Step 2.
Unknown optional actions and possible replay/goal classification conflicts are
not locked, and observed goal coverage is checked before the handoff. Matching
scene guides are then reused for dense association without another Gemini call.
Older already locked local checkpoints still observe pending scenes without
changing their selected intervals; they cannot enter the new source selector.
At most six semantic anchors describe the carrier, contacts, flight and payoff.
They disambiguate actual detector candidates; they do not create direct ball
observations, player names, interpolated camera commands or crop approvals.
The saved guide is bound to source bytes, scene ID, exact interval, model and
guide version. Retrying reuses matching guides and raw detections.

Same-shot search corridors do not cross source cuts. During an unknown flight,
an observed destination may permit a smooth look-ahead rather than holding an
obsolete player envelope until the last frame. An approximate semantic goal
rectangle is a target preference, not a requirement to fit the entire goal
instantaneously. Direct ball containment remains mandatory. Unknown ball
intervals stay unknown, and uncertain annotations disappear.

The actual rendered portrait video must independently pass motion, subject,
contact and outcome review. Contradictory goal/save verdicts are not converted
to approval. A successful individual crop is not a completed narrated recap.
The local Chelsea/Hull end-to-end run is still under review; these changes have
not been deployed to production.

The previous local queue verified all four selected goals after the motion and
phase-clock fixes, but nine other scenes remained unverified. That job has no
finished narrated export. A fresh upload exercises the pre-lock selection order;
do not present the diagnostic goal crops as its final video.

The fresh run exposed a local source-selector bug: it treated the six sparse
guide anchors as tight edit boundaries and shortened the selected capacity to
49.5 seconds. The selector now preserves the initially observed buildup and
follow-through, extending only an actually truncated completion. A later replay
contact cannot overwrite the first completed action. Missing sparse setup
anchors may use the initial video's explicit setup observation, but no ball
coordinates or crop approvals are fabricated; Step 2 still independently checks
the resulting moving crop. Sub-frame clocks claiming a cross-field action in
35 milliseconds are rejected rather than scaled or accepted. Regression tests
cover these cases and ensure guidance precedes view choice and locking.

The corrected local test locks 14 separate scenes including four observed
goals and passes the 60-second source-capacity gate. Dense tracking and the
finished narrated export remain under test. This is not a production rollout.

Hybrid detection now emits each atomically saved scene checkpoint as it is
completed. A bounded streaming queue starts independent crop review while
the remaining clips are still being measured, rather than waiting for the
entire Python queue. The producer loads models once; at most two reviews run
concurrently. Reviewed scene evidence is saved immediately and is merged AFTER
the native aggregate so an unreviewed result cannot overwrite approval. Active
review siblings are drained before any recovery retry. No incomplete source
checkpoint is reviewed.

The live test confirmed this overlap and approval of the first goal, but two
other goal crops still failed. During short same-shot detector gaps, estimated
old-player envelopes forced late camera snaps. The camera now releases ONLY
unknown interior constraints between two native ball observations when their
measured displacement requires a handoff; both direct endpoints remain hard
constraints and source cuts cannot be bridged. A late semantic anchor is not
used as an opening coordinate. Physical source-edge clearance is preserved
where available, without treating a native picture edge as an avoidable
internal crop edge. The corrected locked-scene test is still running; there
is no approved final export yet.

The subsequent test independently approved all four goals and 12 of 14
locked clips, exceeding 60 seconds of approved source footage. The two
remaining clips are still being tested; there is no completed narrated export
or production deployment. A changed crop must pass its actual pixel review;
the diagnostic MP4s are not final videos.

Native detail searches now magnify only neighbourhoods of observed semantic
anchors when the broad detector lacks a reliable candidate there. The guide
does not supply a detected ball. Empty searches stay empty and are cached;
supplemental detections have their original model confidence and a cache bound
to the exact source, scene interval and guide. The raw shared cache is unchanged.
Foreground ball-size bounds are relative to an observed nearby player's body,
and X/Y sizes account for the different native width/height normalization.
Sparse goal locations cannot override a current source search region, and a
non-goal destination prior expires after the observed result rather than
forcing the rebound toward an old goal location.

Reaction and non-finishing-action reviews no longer receive contradictory
shot/goal requirements. They still need a visible relevant subject, stable
movement and an actual resolution appropriate to the action. Unknown pixels
cannot be approved merely by changing the event label.

A fully evaluated locked queue emits FIXED_SCENE_FRAMING_PENDING when crops
remain unverified. Automatic recovery does not re-run identical camera paths
and cached rejections two more times. It preserves the clips and reports that
a changed camera plan is needed. Temporary Google service/capacity failures
still wait and retry automatically. This removes no-op retries; it does not
guarantee that every source can be correctly framed or bound provider wait time.

The subsequent local test preserved 13 approved scenes and isolated the last
goalkeeper-pressure scene. The role detector's existing full-picture pass had
seen the actual football, but separate-specialist mode discarded that class.
Its old ROI could then report a confident white boot and suppress global
reacquisition. Role-ball proposals now remain measured candidates, with their
original confidence and detector provenance; no extra semantic requests are
required. Foreground ball size also retains the observed shot's player scale
after the ball leaves the player's feet. Interpolated semantic coordinates
have a bounded association cost because camera pan makes linear source-box
interpolation unreliable. Actual observed anchors retain their stronger cost.

A bounded cached opening-person check handles a foreground insert missed by
the wide-shot role model. It uses the existing yolo11n model when available,
only for the opening sample and confirmed close-up continuation. Measured
body boxes can constrain framing without assigning a name, possession or an
unobserved football. Large foreground-to-medium-view dissolves reset source
shot continuity so a later ball location cannot preposition the close-up.

## Completed-video narration (October 8)

All 14 clips, including four goals, passed independent actual-crop review in
the local test. Narration now follows a rendered visual master, not only source
notes or an estimated word budget. `visual-master/edited.mp4` retains the crop,
freezes, grades, annotations and result header; a complete muted video proxy
is attached to the first script request. The renderer's measured cut clock
replaces the older manifest's estimated transition overlaps.

The writer supplies one exact scene entry, basic English, specific visible
causes and an engaging chronological recap. Word estimates guide writing but
one-word/global count differences do not reject a timed recap. Scene recording
uses at most two concurrent TTS calls. Only linked same-incident reaction
support shares a recording. Each actual take must fit its own visual window;
overlong sections alone receive measured, shorter wording. Successful takes
are retained. This is not a promise that generative speech fits on its first
attempt or that provider capacity waits disappear.

Final assembly overlays narration subtitles and mixes normal-speed, positioned
voice with the existing edited video's sound accents. It does not reselect,
retrack, crop, speed up or pad the visual story. Exact visual/script/voice
checkpoints are keyed to the source, render and configured voice. The new flow
resumes these checkpoints instead of falling into the legacy render-repair
writer. No production deployment is implied by a local test.

Live integration exposed two additional causes of unnecessary rewrites:
fractional video/audio endpoints accumulated roughly 0.4 seconds across cuts,
and the production-language check rejected the football verb in "clips the
frame". Each renderer branch now has a shared whole-frame endpoint and real
FFmpeg coverage verifies its exported clock. Physical contact verbs remain
allowed while actual replay/editing instructions are rejected. Previously
saved video-reviewed drafts are revalidated under the corrected checks before
requesting another model review.

The updated local production path completed an 89.033-second, 1080x1920
export using all 14 locked clips and 12 normally paced voice windows. Four
overlong windows received one batched, 3.135-second text-only shortening
request; other takes were reused. A missed chance's ending no longer claims
to "seal" the draw; the independently verified final result is a separate
sentence. Its correction reused the visual master and 11 voice takes.

Final actual-video/audio review approved the corrected export with no issues,
four visible goals, clear naturally paced speech and readable captions. HTTP
range streaming returned 206 with the expected MP4 bytes. The focused Node
suite passed 180 tests, a real FFmpeg fractional-cut/freeze test passed, and
the application build passed. Provider voice-capacity waits still occurred
and retried automatically. These results are local, not a new deployment or
a guarantee about every future source/provider response.

## Initial scoring-action preservation (October 8 UI test)

The fresh Netherlands–Germany UI test exposed two goals that Gemini had
already observed but the local initial-phase validator discarded. Both were
complete crosses/rebounds: goalmouth attention began 0.2–0.5 seconds before
the final scoring touch. Initial source phases may now overlap, while all
timestamps must remain inside the clip and the resolved result must still
follow release and final contact. The ordinary tracking-brief normalizer
keeps the downstream ordered camera clock; no source boundary is changed.

Scoring obligations are now recorded from the successful raw section response
before passages are locally filtered. The pre-lock audit checks both goals
and disallowed goals against the selected complete actions. A rejected goal
can no longer disappear from the expected incident set, making a zero-goal
selection look complete. Unknown total match scores are explicitly marked
unknown. This audit adds no Gemini request and no rediscovery/repair loop.

The local app is explicitly configured for the previously tested hybrid path
with fast tracking and Pro rendered-crop review. This does not change the
unconfigured server default or deploy the configuration to production.
The new end-to-end UI retest is pending fresh file selection; the preceding
job stopped on the older Gemini-only framing path and is not a valid final
recap. Regression success is not final-video approval.
