# Source-first football recap workflow

## Current complete-recap contract (2026-10-07)

1. Probe the original upload and index source broadcast-camera cuts locally.
2. Divide the source into bounded overlapping sections (normally about three
   minutes). Send **one initial Gemini video-analysis request per section**.
   The request asks for every useful distinct complete action, one clear source
   angle per incident, portrait readability, initial focus-route notes, natural
   phase times, and visible setup/continuation/result descriptions. The clearest
   complete view wins, rather than automatically choosing the earliest live view.
   All goals, useful chances, saves and attacking combinations
   are considered in that same pass. No fixed five-second scene cutoff.
   The current profile uses Gemini 3.8 Flash at 2 fps with HIGH media detail;
   both the encoded proxy and request sampling use 2 fps. Precise Step-2
   framing retains Pro and its independent higher-detail video profile.
3. Save each section's successful raw response, including an empty section,
   before local validation. Source/model/contract fingerprints prevent unrelated
   cache reuse. A restart restores completed sections. Google capacity/service
   retries repeat the same unfinished request, not a new discovery pass.
   A role/FPS update retains compatible completed observations with their
   actual model/FPS provenance; only unfinished sections use the new profile.
4. Validate timestamps, shot membership, declared visible phases and outcomes
   locally. Deduplicate section overlap and repeated angles; preserve all
   observed scoring incidents. Distribute flexible source-section budgets for
   the 60-second recap minimum. A quiet section may contribute less; other
   sections contribute more. Do not fabricate missing action or pad duration.
   Inconsistent observations are recorded in separate section reports.
5. Lock source selection and save each chosen original-ratio muted scene as
   its own file. There is **no combined scene video at Step 1**. The progress UI
   distinguishes source-observed actions, prepared clips and verified cameras.
6. Track every locked scene separately in Step 2 using its own scene-local
   clock and Gemini video observation. Calculate stable full-bleed 9:16 position
   keyframes, following initiating player+ball to receiver/goalkeeper/result.
   Make one initial camera plan, then review the actual portrait crop once.
   Do not remove scenes, change source boundaries or return to discovery.
   Initial observations and actual-crop reviews use video only: no extracted
   JPEG batches or missing-image readiness markers. The initial observation
   records the complete focus route and consequence before coordinate rows,
   including the final visible involved subject. It uses HIGH reasoning; crop
   review retains MEDIUM. There are no automatic coordinate corrections,
   geometry repair rounds, outcome rechecks or scene-boundary replacements.
   Provider capacity/timeout retries repeat only the unfinished request.
   Input-time trimming precedes FPS reduction to retain fractional end ticks.
   Missing or contradictory visual evidence is saved honestly and cannot be
   converted into a passing crop merely by removing the repair loop.
7. Plan evidence-linked effects, freezes, captions and transitions, and lock
   the exact visual timeline. Write basic-English recap words against its real
   durations; use names only after grounded identity verification. Record
   clear, naturally paced original narration last; broadcast audio stays muted.
8. Combine only the fully prepared scenes at final rendering. Inspect the MP4
   pictures, sound, captions and complete actions before delivering its URL.

### Removed from the current Step 1

No routine second whole-source inventory, scoreboard-image requests, semantic
review reels, independent goal-check requests, missing-goal searches, duration
searches, or per-shot-audit correction calls. A source observation is explicitly
labelled `gemini_initial_section_video`, with `independentReview:false`.
It is not represented as independent verification or final portrait approval.

The filename score is context and a local diagnostic only; it never proves an
unseen goal. Every goal actually observed in the accepted source evidence must
survive selection. Genuine insufficient/contradictory source evidence still
needs attention: removing quality checks cannot make an unobserved goal real.

### Verification

Regression checks cover single-call section orchestration, completed/empty
section reuse, partial service recovery, local phase validation, overlap
deduplication, goal preservation and separate source/portrait assets.
A fresh Chelsea–Hull local test is running; a finished export has not yet been
certified. This update has not been deployed to production.

The one-pass implementation passes 676 offline JavaScript regression tests and
TypeScript checks. The latest targeted framing/source-selection/recovery run
passes 87 tests. These are code checks, not a finished-video pass.

Live QA: four of fifteen portrait scenes are verified. The first new
scene-5 observation returned no subject coordinates for its final 1.5 seconds;
that response was saved and no automatic repair was started. The strengthened
initial-video contract now uses HIGH reasoning, timed focus-route notes and
explicit final-subject observation. Only unverified initial observations use
the new contract; verified scenes and Step-1 selection remain preserved.
The updated initial-plan test completed but still did not pass scene 5:
one returned contact/control row was excluded for contradictory subject boxes.
The rejection used to be reported as a missing row. Initial answers are now
saved in full before validation, with specific rejection reasons retained across
worker restarts. No correction call is made. No final MP4 or deployment is claimed.

A resolved goalkeeper-focused payoff requires the observed goalkeeper,
not a separate unrelated outfield player. Source notes and the actual crop
must both verify goal crossing before a coarse shot label can become a goal.
Missing subjects, invented coordinates and contradictory outcomes cannot pass.

Portrait review is evidence-first: observed contacts, ball path and consequence
precede Boolean verdicts, with no tentative save/rebound checklist supplied as
an outcome cue. A preview review is cached by its actual bytes and camera plan.

Editing effects do not establish copyright clearance or guarantee provider
capacity. Historical notes below describe superseded workflows, not instructions
to re-enable repeated discovery, outcome rechecks or framing repair.

## Validation status

### Source-native endpoint audit (2026-10-06, semantic version 19)

The locked Brentford test `05759b7e-c3a3-4c6c-9fcc-2880fa904e49` was intentionally
stopped after source/crop comparison rejected its fifth scene: the selected
cut-back ended before receiving control. Earlier semantic review had incorrectly
called it a completed missed shot. The locked queue was not trimmed, replaced,
or force-approved, and its diagnostics remain preserved.

Source reviews now include four native-detail endpoint witnesses for each
proposed gameplay candidate, correctly labeled with its clip-local clock,
alongside the entire source review clip. High reasoning inspects the LAST
included release and its directly visible consequence, distinguishing an
unfinished cut-back from a missed shot. Isolated corrections receive the same
scene's endpoint witnesses and reasoning policy, not another scene's frames.
Semantic version 19 invalidates earlier completeness approvals. This strengthens
the observation, but its real-video reliability still requires fresh-upload QA.
All 552 JavaScript tests and the application build pass. Fresh upload
`f379b4d8-7e25-4520-be7a-07de0fd10698` under `work/local-e2e-1791271511835` has
started source analysis. No completed video or deployment is claimed for this
change.

### Crop outcome-consistency check (2026-10-06)

Monitoring the Brentford run exposed a gap: a crop review could report a keeper
save even when coordinate observations placed the ball away from the keeper at
the claimed result. A positive review alone previously bypassed source/crop
comparison. Save claims with no nearby observed ball/keeper overlap now require
independent comparison of the actual crop and original source. Likewise, a
claimed non-save result conflicting with an observed resolved keeper touch gets
comparison. These geometry hints do not approve or reject the sporting outcome.
The original source still cannot approve action hidden by the portrait crop.

Approval cache entries require outcome-consistency version 1. Matching source
coordinate batches remain reusable; a previously successful higher-detail
attempt is retained when only the review policy needs updating. All 551
JavaScript tests passed. The local worker was intentionally reloaded to apply
this global check and resumed the unchanged 16-scene lock. Actual crop re-review
is ongoing; no final-video pass or deployment is claimed.

### Duration-search exhaustion repair (2026-10-06)

Fresh Brentford test `05759b7e-c3a3-4c6c-9fcc-2880fa904e49` found all three
awarded goals but stopped before scene lock at 53.275 selected seconds. Recovery
was restricted to three attempts and sampled one frame/second, without remembering
negative searches. This is not a passed export or a portrait-tracking failure.

Duration-only recovery now encodes and observes bounded excerpts at eight
frames/second, uses FPS-specific proxy paths, checkpoints completed search windows
(including zero-candidate results), and explores other unsearched gaps instead of
repeating a gap until an arbitrary three-attempt cutoff. Four-second gaps remain
eligible; selected actions still have no fixed length limit. Recovery ends when
selection passes or useful unsearched windows are exhausted. It does not fabricate
coverage, repeat goals, pad the ending, or change the locked tracking queue.

All 550 JavaScript tests and the application build passed. Resuming the same
fresh upload before lock produced a 62.44-second selected source queue, including
all three awarded goals. Step 1 passed and saved the fixed 16-scene queue; the
sequential Gemini portrait-crop test is in progress. No final MP4 or production
deployment is claimed for this repair yet.

### Fixed live-first scene queue (2026-10-06, workflow version 12)

#### Physical scene separation and independent camera clocks

After selection is locked, `source-scenes/manifest.json` records a separate
normal-speed, muted, original-dimension MP4 for each selected interval. Scene
length is action-dependent, not a mandatory five-second cap. No concat or
portrait crop occurs while these source clips are prepared.

Gemini framing reads one separate clip at a time with a local clock starting
at zero. Absolute source phase times are translated without modifying the
original selection. Every passed camera path also produces an independent
`portrait-scenes/` asset. Final rendering reads the separated source clips,
applies their verified local camera paths and existing editorial treatment,
and combines them only after the entire selected queue has passed tracking.

An in-place camera repair uses a fresh observation-cache signature and starts
with native-detail observations; it cannot reuse the failed coordinate answer
as a new attempt. Up to three rounds are allowed. If evidence remains
unverified, the scene stays selected and the problem remains explicit; no
fabricated camera approval, scene omission, or narration is allowed. This is
not a guarantee that every source action can fit a full-bleed portrait crop.
Completed source/portrait assets survive cloud checkpoints; unfinished
`.pending.mp4` encodes do not.

Later presentation helpers cannot shorten a locked reaction, slow down a
locked action, or drop a selected short scene to fit a target duration. The
final renderer preserves the selected queue and normal 1x motion.

Implementation checks: 574 JavaScript tests, TypeScript checks and the application build pass.
A real FFmpeg synthetic smoke test produced two independent normal-speed
1080x1920 clips with separate local camera paths. This checks encoding and
clock isolation, not football visibility. A fresh Brentford upload test
was paused while the UI was replaced, and is archived before the next new
upload. Final-football QA and production deployment are not yet complete.

The next fresh upload is `d55112c4-0768-49ab-a1a9-f4f026feb57c`, under
`work/local-e2e-1791275200267`. It is running locally, with new source analysis
and no previous-job caches. Its source observations survive a worker reload
during an automatic capacity wait. The live browser was checked against this
real job: source discovery correctly remains Step 1 even if its internal stage
is `tracking`. A local original-preview rule that previously revoked access
after analysis starts was also removed; secured sources remain playable during
tracking/rendering/completion, while incomplete uploads remain unavailable.

The progress UI now uses `workflow-progress.mjs`, shared by the processor,
gateway and browser. Selected source intervals, clip-save counts, verified
camera counts and per-scene tracking states are durable job data, not inferred
from percentages. Camera state is saved after each scene; changing projects
cancels the previous polling loop. Effects planning, the locked script,
recorded narration and completed render have distinct completion flags.
Capacity waits show automatic retry instead of asking the user to resume.
An incomplete browser upload is explicitly not labelled background processing.
The old animated scanner and stage-index display were removed, not duplicated.

The actual processing component was server-rendered in automated tests and
visually checked in Chrome at desktop and 390px phone widths using clearly
labelled fixtures. All twelve fixture scene cards were present, with no
horizontal overflow. These layout fixtures do not claim football framing QA.

This supersedes the provisional portrait-angle preflight below. Step 1 chooses
one independently complete source view per incident, preferring a complete
single-camera live view and then the earliest such view. A multi-camera parent
is retained when no independently complete atomic live view exists. A replay is eligible only when the live view was not independently
complete; repeated replays are not mandatory tracking work. Scene IDs and source
intervals are then saved in `fixed-scene-queue.json`.

Step 2 tracks every selected scene sequentially, checkpointing its camera
results. It cannot promote reserves, compare alternative goal angles, remove
selected chances or trim source boundaries to conceal a failed crop. A queue
review checks every selected scene before narration. A tracking failure remains
an explicit camera problem for that same scene, never permission to omit a goal.
The fixed-slot script and resumable voice-take protections remain in place.

The camera also no longer requires unrelated distant keeper/post context during
tackles or playable loose-ball clearances. It follows the observed moving ball;
relevant nearby goal boundaries and goalmouth finishes still receive independent
actual-crop verification. A playable ball cannot be ignored merely because an
observer labelled a continuing wide shot as a reaction.

The fixed queue also bypasses later duration-guide truncation and backup-scene
substitution during edit alignment. Every selected source interval remains at
normal 1x speed. Selected reactions, if any, retain their exact Step 1 bounds
and receive their own narration slots rather than disappearing from the outline.

Long incident searches observe their overlapping windows in source order and
stop once a complete live candidate is found. Later-window goals cannot own a
score change that was already visible earlier. These are discovery checks only;
every selected action still undergoes independent source and crop verification.
When one search also observes the next goal, its actual phase clock and the
independent score ledger assign that candidate to the correct incident. The next
incident does not need another overlapping discovery call; no source/crop
approval is inferred from this reuse.

Duration recovery now prioritizes unused interior passages between observed
football actions over a longer full-time/outro tail, retaining a short source
context handle around the gap. Its purpose is explicit: find new complete
gameplay, not celebrations, statistics or repeated goals. Unrelated reaction
observations remain saved but cannot satisfy a missing-action duration floor.

The local duration test exposed two more source-selection defects: honestly
corrected free kicks/corner clearances were excluded by a narrow event/phase
whitelist, and a broad score-search anchor could hide an earlier chance's own
unchanged-score context. Complete defended actions now remain eligible after
independent review. Outcome adjudication examines nearby score context first,
allowing a short scoreboard-update delay, rather than assuming that a later
goal belongs to an earlier passage. A corrected miss releases its provisional
score binding; it does not count as a goal. Saved alternatives rejected only by
Step 1 ranking can be reconsidered before lock. Actual semantic rejections and
locked source intervals are never reopened by this ranking cleanup.

The local camera test also exposed a different gap at a genuine source dissolve:
the first new-shot carrier briefly concealed the ball, so a same-shot
before/after rule could never pass that cut entry. A bounded, independently
observed cut-entry hypothesis now retains the visible carrier and the entire
subsequent control region. It does not manufacture a hidden ball box, bridge
flight/finishing evidence or modify the locked interval. The actual crop must
separately verify the same player's visible control before any pass/shot;
an absent contact, payoff or off-screen ball still cannot pass. This optional
repair does not invalidate previously approved camera paths.

Further testing found that generic source pre-roll/result handles could retain
the preceding play or a different restart. Semantic observation version 17 now
proposes and verifies the exact complete source interval before lock, explicitly
excluding unrelated lead-in/tail. Absolute phase timing remains anchored to the
original review clip, not the newly shortened interval. Matching Step 1 caches
restore these reviewed bounds; a locked interval remains immutable.

Coordinate samples now retain the decoded source frame at/before each labelled
sample tick. Focused high-detail images and magnifications use that same sample,
not an independent seek that can show a different frame around a kick or cut.
Legacy incomplete observation batches cannot seed this new sampling clock.
Already independently approved actual crops remain usable.

The new test also exposed a score-ledger boundary collision: the third goal's
verified payoff coincided with a coarse sample that still showed the earlier
score. Independently complete live goals now receive chronological ownership
only when their distinct source actions exactly cover a coherent score history.
The proof is bound to the ledger and unchanged source interval; an absent goal
or duplicate angle cannot manufacture coverage.

Recovery now gives uncovered opening footage the same priority class as interior
football gaps, ranking both by unused length before a likely full-time tail.
The fresh test exposed the previous rule repeatedly searching short interior
gaps while missing early chances, then stopping at 46.6 seconds. Exact approved
source windows also bypass obsolete generic trimming on later discovery passes,
so the same visual approval is not needlessly invalidated and purchased again.

Brief celebrations immediately adjacent to a verified live goal are reviewed as
reaction support, with no requirement to repeat the goal's setup or ball flight.
They remain independently observed pixels, never proof of the scoring action.
Unrelated reactions and VAR footage stay deferred. A reaction beginning within
half a second of a goal's ending links to that latest verified goal, including
when discovery originally assigned both later goals to the same score search.

All 547 JavaScript tests and the application build pass. The initial isolated
upload `b76cbac5-4904-4beb-b88e-555c2b9b4a0b` reached 67.7 verified source
seconds and three approved portrait crops, but exposed the cut-entry and source
boundary defects above. It was intentionally stopped with its lock/evidence
preserved, not rewritten into a successful test. Fresh upload
`3318e9f3-fe29-4d2d-9c04-a1f4245a228a` selected 61.39 seconds across 16 scenes,
including all three awarded goals and their immediate celebrations. Four
portrait crops passed. Its fifth scene exposed an unresolved outlet pass after
an earlier successful dribble. It was intentionally stopped; its original
locked boundaries and failed tracking evidence are preserved, not altered to
hide the unfinished action.

Source selection and portrait observers now share explicit non-shot completion
grammar: receiver control/interception/out-of-play for passes, retained control
after a challenge for dribbles, and a visible recovery/clearance/decision for
duels. The LAST included release must resolve; earlier control cannot approve
a later unfinished pass. Step 1 can inspect two seconds of additional review
context for unsplit non-shot candidates, but that context is not automatically
selected. Locked and atomic camera views remain exact. All gameplay source
reviews use 8 fps. The full payoff interval must fit the selected source window;
non-shot phase clocks now receive the same validation as shooting actions.
Semantic contract version 18 and Gemini framing version 10 invalidate stale
observations; no approval flags are fabricated.

A new isolated upload `05759b7e-c3a3-4c6c-9fcc-2880fa904e49` under
`work/local-e2e-1791261608816` is testing these changes from a fresh source upload.
Its pre-lock test also exposed a one-frame phase-hold overshoot: the explicit
positive payoff interval fitted the chosen source window, but the general hold
ended one 8-fps sample later. That narrow metadata discrepancy now uses the
explicit observed payoff end, with the raw end recorded as a correction. Missing
or uncertain payoff evidence, negative visibility flags, invalid result boxes,
and longer overshoots still require reobservation. No contact, scene boundary or
visibility flag changes. The isolated worker was restarted before scene locking
to load this fix while retaining completed source observations.
The finished video/audio have not yet passed QA, and these changes have not
been deployed to production.

### Portrait preflight and fixed narration slots (2026-10-06)

Actual portrait framing is now checked while Step 1 angle selection is still
provisional, before writing the immutable scene manifest. A failed optional
angle is excluded there; a required goal must retain a verified same-incident
view. Approved camera paths are reused after locking, not purchased twice.
`source-framing-preflight.json` records the actual crop results and unresolved
incidents. The goalkeeper/goalmouth remains the camera owner after a finish in
the same wide shot; a distant celebrant is not a reason to pan away from the
result. A measured source cut can hand the view to a close-up reaction.

The writer now receives the reviewed output clocks, including transition
overlap, and must supply words for every exact scene ID. The application owns
IDs, order and evidence bindings; Gemini owns only narration and captions.
Malformed drafts are corrected within the writing stage. Approved scripts are
checkpointed with their visual-timeline, model and fact provenance and are
revalidated before reuse. Initial complete-recap copy uses 153–171 words per
minute to fit the existing voice-performance instruction; a measured recording
can refine that budget without changing the footage.

Voice requests split on sentence/word boundaries using UTF-8 byte limits.
Temporary TTS quota, timeout and availability errors retry within recording,
with a visible wait state. Valid measured takes are cached independently, so a
later failed chunk does not require recording completed chunks again. Permission,
billing and invalid configuration errors are reported rather than retried as
capacity errors. Empty recordings cannot become successful cached takes.

All 515 JavaScript tests pass, including fixed-slot writer correction, exact
timeline clocks, approved-script reuse and transient TTS retry tests. These are
automated implementation checks, not approval of a finished production video.
The new production export and audio/visual QA are still pending.

### Current one-minute match-recap policy (2026-10-02)

The current user request supersedes the older no-floor short exports below.
New complete recaps require at least 60 seconds. UI and processor defaults agree.
Step 1 combines overlapping excerpt inventories, selects complete distinct goals
and useful chances, and performs coverage recovery before locking scenes.
Extra inventories now request up to eight meaningful actions per excerpt;
selection may exceed its usual extra-scene count when distinct action coverage
still needs to reach one minute. No excerpt is individually required to provide
one minute, and overlapping copies are not counted as new coverage.

Incident chapters now follow source chronology regardless of excitement scores.
Script beats must preserve the reviewed visual order and use a consistent
114–141-word budget per minute, rather than the previous 180–192 words.
Basic-English narration connects the match's developing story, without treating
the last selected clip as proof of the last match incident. Voice recording
remains after the visual timeline is locked; framing is repaired scene by scene.
The pre-tracking plan is saved in `step1-recap-plan.json`.

The previous source inventory had useful chances that later reviews misread as
goals. Finishing actions now receive isolated semantic reviews, and independent
outcome reviews include unchanged-score context when reliable native samples
bracket a live scene. This context is not a ball track or an instruction to
invent a save/disallowed-goal verdict. Inventory merging preserves additional
action provenance so those scenes remain eligible for Step 1 selection.
These changes require a new end-to-end export; the earlier 25.2-second approval
does not validate the new one-minute policy. No server deployment is claimed.

The expanded recap inventory now performs a separate whole-source non-goal
scan after score-anchored goal discovery, rather than treating readable score
history as a complete chance inventory. It selects up to six verified strong
saves, shots, misses or defensive actions without a minimum duration or filler.
Each distinct chance gets one selected source angle before framing.

The current fresh local test exposed stale semantic phase estimates despite a
visible correct goal crop. Complete independent crop phase checks now bind the
editorial contact/result timing without moving the camera or scene boundaries.
An opening cross cannot replace an unobserved final shot. Contradictory
goal-versus-save verdicts require an unbiased native crop reobservation;
negative verdicts are not coerced into approval. A rejected hybrid crop can
request a genuinely new Gemini visual camera plan for that same locked scene,
which must pass its own framing and actual-crop review before being used.
Native outcome requests retain dense extraction but send at most sixteen
phase-aware detail images plus the complete scene video. Short already-split
camera views retain their complete native action even if an estimated contact
time is late. This reduces redundant input without inventing evidence.
Visual observation requests now use sixteen-frame batches; an already saved
larger contiguous batch remains reusable without observing those frames again.
All 377 JavaScript tests and the application build pass. The expanded fresh
upload `ca4e52e1-f851-49a5-a2e7-bde807619299` completed under
`work/local-e2e-1790916618519`. Its 25.20-second 1080x1920 H.264/AAC export
contains both awarded goals and one additional dangerous chance, with source
audio muted and normal-speed play. No filler or minimum duration was added.

The added chance exposed disagreement between source and crop reviews about
a save versus woodwork. Script-facing evidence now retains their confirmed
non-goal facts and rejects disputed mechanisms or invented current scores.
Raw observations remain available for audit; neither scene bounds nor goal
coverage are changed by this narration policy. The camera solver also uses
backward reachability to avoid a late pan while retaining its speed bounds.

Finished-video-only reviewers subsequently misread that chance as a goal.
Native full-width finish frames showed the rebound returning into play. A
source-backed finished-export review (`final-video-review-v4.json`) passed with
no reported issues, two visible goals, stable camera work, readable captions
and intelligible, well-paced narration without competing commentary. Earlier
contradictory reports remain saved; they were not overwritten or converted to
approvals. The review harness now bounds SDK retries with a hard abort deadline
and accepts an explicitly labeled source reference for ambiguous outcomes.
This validates one expanded local export, not production throughput: provider
timeouts and repair iterations made this run too slow to establish a 30-minute
turnaround. No production deployment is claimed for these changes.

The application build and regression tests are checked during implementation.
The clear-angle workflow passed all 356 JavaScript regression tests, including
replay-only chosen-angle coverage, backup promotion, camera-cut segmentation,
corrected-shot exclusion, exact shot boundary retention, result-safe trimming,
matching positive-observation reuse and non-blocking overturned-finish handling.
Rendered-crop review now sends the short video and at most eight native-detail
frames around setup, contact, flight and finish, instead of 24 enlarged stills.
Dense tracking is unchanged; this reduces redundant model input rather than
relaxing the action-quality checks.
The isolated local export completed and passed finished-video review. It is
1080x1920 H.264/AAC, 13.30 seconds under automatic natural-duration settings,
and contains both awarded goals. Native-detail visual review found stable camera
movement and readable captions; audio review found intelligible, well-paced
narration without competing broadcast commentary. This is one tested source,
not a claim that every football broadcast has been validated.
Local testing also exposed and corrected three checkpoint/path problems:
empty post-rejection scene lists must recover the immutable source manifest;
incomplete later timelines cannot replace its complete locked incident set;
reviewed hybrid/Gemini crop paths must not be modified by legacy post-review
trimming or reprojection. An awarded goal without a passing angle now remains
locked for repair rather than disappearing before narration.
The first completed export exposed stale discovery facts in narration. Script
input now uses the approved crop's timestamped phase observations in preference
to those older notes. The corrected export passed review with no reported issues
and two visible goals (`final-video-review-v2.json`). One complete verified action
is also no longer rejected by an arbitrary two-scene minimum; awarded-incident
coverage and nonempty-action checks remain enforced.
An interrupted-test resume exposed an over-escaped Windows font drive separator
in the source-review label. The correction passed a real FFmpeg label render
and the semantic-policy regression tests; Linux font paths remain unchanged.
The new isolated upload `53af3eef-2253-4017-aa38-c5cbb77a0834` completed under
`work/local-e2e-1790850886839`; the MP4 is in
`data/outputs/53af3eef-2253-4017-aa38-c5cbb77a0834/final.mp4` beneath that directory.
No production deployment is claimed by this document.
