# Reduced Gemini workload

## Current Step 1: one initial video observation per source section

Complete recaps now bypass the historical scoreboard, semantic-review-reel,
goal-outcome and recovery-search chains described below. Each source section
has one structured initial video request covering goals and non-goal action
together. Its successful response is checkpointed before local validation;
empty completed sections are cached too. Google capacity/service retries
repeat only the unfinished request. No routine JSON correction or source
rediscovery follows a successful section response.

Local code checks complete action phases and clocks, reconciles overlap,
selects one clear view per incident and locks separate original-ratio clips.
Initial evidence is explicitly labelled as initial video observation, not an
independent review or passing portrait crop. Step 2 still observes individual
scene videos and verifies the actual 9:16 camera path. See
[the current workflow](source-first-football-workflow.md).

## Historical Step-1 goal coverage and source handoff (superseded)

A partial scoreboard ledger could have one covered transition while a scored
upload still lacked another live goal. The duration recovery then assumed all
goals were covered, and the filename-count gate ran only after provisional
selection had been locked. This prevented split clips from being saved. A
second retry problem let higher-importance unverified overlapping drafts evict
independently reviewed complete source actions during deduplication.

Goal-count completeness now requires independently verified, complete,
non-deferred source goals. A dedicated dense, bounded Step-1 search resolves
the deficit before selection and scene locking. Completed searches rotate to
fresh windows. Unresolved multi-goal score jumps are searched before empty gaps;
new/corrected source proposals receive independent review before overlap
deduplication so a short earlier chance does not conceal its later payoff.
Goal-count discovery uses the configured discovery-role model; detailed source
verification retains the vision model. Partial paid discovery results are restored using source/model
provenance before those windows are skipped. Restored proposals still require
independent semantic/outcome review. Verified source actions outrank unverified
drafts in duplicate filtering. Step-2 scene boundaries are not replaced.

The source-count gate precedes committing the scene manifest; only then are
separate clips prepared for portrait tracking. Exhausted footage or conflicting
metadata still needs honest evidence review, rather than fabricated goals.
The UI separately reports source-reviewed actions, saved clips and verified
keyframes, explains section-boundary ownership, and uses the active provider
retry clock instead of a stale previous recovery deadline. Live footage QA
and production deployment remain separate from regression-test results.

## Step 2: one initial video camera plan (2026-10-07)

Each locked scene receives an initial original-video observation with timed
focus-route notes before coordinate rows. HIGH reasoning is used for this
initial observation; the independent actual-crop video review uses MEDIUM.
Input and coordinate clocks remain at 8 fps with HIGH media detail. There are
no JPEG batches, local detections, fabricated coordinates or scale pumping.

For short actions up to 20 seconds, every output batch sees the complete scene,
including its consequence. The maximum 80-row output array is not a source
scene boundary. Longer scenes use bounded neighbouring video windows.

Dense observations are visibility constraints, not recenter commands.
The camera holds while required subjects fit, then uses bounded necessary
position movement. Scene clocks, boundaries and selection remain locked.
Only fully prepared scenes are combined at final rendering.

Automatic geometry repair, row-correction requests, focused reobservation,
boundary replacement and extra outcome comparisons are disabled in the active
complete-recap framing path. Missing evidence is saved for attention, not
silently approved. Google capacity/timeout retries repeat only the unfinished
request and reuse successful checkpoints; they are not framing repairs.

Initial-plan cache keys change with the observation contract. Already verified
cameras still return first, without repeating paid work. Actual crop reviews
are keyed by preview bytes and camera plan. No paid traffic-tier change is made.

Live QA: four of fifteen scenes are verified. The scene-5 initial response
omitted all subjects at the ending and did not pass; no repair loop followed.
The strengthened initial observation completed but still returned contradictory
contact coordinates. Complete initial answers are now saved before interpretation;
rejected rows retain their actual cause rather than being reported as omissions.
No complete-video pass or production deployment is claimed. Historical notes
below are superseded.

## Confirmed Step-1 request rejection (2026-10-07)

The fresh job later stopped at 32% with HTTP 400 INVALID_ARGUMENT while
verifying four source scenes. This was not a capacity error or missing footage.
A no-media control reproduced the rejection using the exact four-scene schema
and the same Pro model. Removing only the `candidates` array's fixed
`minItems:4` / `maxItems:4` constraints succeeded, returning all four exact IDs
in 11.303 seconds; removing all array bounds also succeeded in 8.317 seconds.
The rejected control returned 400 in 0.913 seconds. The result and legacy
schema are saved under `work/semantic-schema-diagnosis-20261007`.

The shared Step-1 schema builder now omits only those candidate-array bounds.
Required fields, ID enums, boolean verdicts and four-coordinate box constraints
remain intact. Application-side validation rejects missing or duplicate scene
IDs and reobserves just those IDs; ambiguous duplicate corrections cannot
select a favourable verdict or overwrite valid siblings. No visual gate,
incident coverage rule or scene duration was bypassed.

Invalid-request diagnostics now identify the request label, model, media
counts/sizes and schema hash without logging API keys, headers, user text,
source URLs or media bytes. The saved diagnostic job was resumed to replay
the previously rejected real-media batch: it now passes, and all 12 source-scene
batches are saved. The four-scene response needed one focused missing-ID
review; valid sibling reviews were retained, and the final response contains
each expected ID exactly once. The main media request took 71.716 seconds;
the focused review took 49.134 seconds. This is a scene-review pass, not a
finished-video or production-deployment pass. All 631 offline Node tests and
TypeScript checking passed after this fix. Full end-to-end QA remains running.

Google documents that complex structured-output schemas can return 400 and
recommends reducing constraint complexity:
https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output.

The superseded complete-recap workflow used one unified broadcast inventory per source
section for goals, chances, saves and useful buildup. A completed inventory
does not trigger a second all-source non-goal pass. An independent scoreboard
audit still runs once. Basic scoreboard OCR uses the discovery-role model; independent goal
action verification retains the existing detailed vision model. Unresolved
incidents can receive targeted source
checks before scene selection is locked. Nothing bypasses coverage or framing
verification. Discovery samples at up to 2 fps; selected-scene observations
retain the existing dense sampling and verified original-frame coordinates.

When a discovery timestamp lands in a replay and score coverage remains
unresolved, Step 1 proposes complete measured camera shots around the missing
transition for neutral visual review. A score cue never approves a goal. Short
source-shot proposals retain their own clocks, require complete action/outcome
evidence, and are considered before buying another broad observation. Reviewed
candidates are checkpointed after each round; retries retain these decisions.
This repair is never applied to an already locked Step-2 scene queue.

The shared request gate has no normal-call pacing, including when a legacy
`GEMINI_MINIMUM_INTERVAL_MS` setting is present. It bounds concurrent requests,
halves concurrency after a provider 429, observes the shared provider cooldown,
and gradually increases concurrency after successful responses. By default,
429 recovery waits grow from approximately 15 to 30 to at most 60 seconds;
jitter never exceeds that application cap. A longer explicit Google
`Retry-After` is still honoured. These shorter retry delays do not remove
Google's capacity limits or guarantee faster completion during an outage.
Worker restore caps legacy application cooldowns to the current retry policy.
New saved waits record explicit provider Retry-After separately so a restart
cannot shorten a provider-requested cooldown.
Temporary 500/502/503/504 and network failures also reduce concurrency and
share a bounded, jittered cooldown. Provider Retry-After is honoured. Invalid
requests and authentication failures are not retried as service outages.
It is not unlimited capacity or a substitute for a provider reservation.

The current deployment profile explicitly selects `gemini-3.8-flash` for
`GEMINI_DISCOVERY_MODEL` and `GEMINI_SCRIPT_MODEL`. Precise keyframe framing
retains `gemini-3.1-pro-preview`; its video sampling/detail is unchanged.
Empty role overrides still retain `GEMINI_MODEL`, and there is no automatic
model substitution during provider capacity retries.
Discovery and scripting use supported LOW thinking effort, rather than Flash's
default MEDIUM effort; correction requests use the same role/effort. No MINIMAL
setting is sent to 3.8 Flash.

Initial source sections use `GEMINI_DISCOVERY_FPS=2` (default, configurable
1–3 fps), HIGH media resolution and 480-pixel proxy height. Both encoded proxy
FPS and the Gemini video metadata match. This uses one-third fewer sampled
video frames than the previous 3 fps profile, not a guaranteed one-third
reduction in total tokens or job time. Generic `ANALYSIS_FPS` and scene framing
profiles are independent. Proxy filenames include FPS and height so stale
media cannot masquerade as a new profile.

Completed initial responses are reusable across role/FPS changes only when
their source fingerprint, initial contract, section plan, shot boundaries and
original cache identity match. They keep their actual model/FPS provenance.
Legacy cache identities are reconstructed and checked before reuse; invalid
contracts/source changes are not accepted. Empty completed sections are cached
too. Only unfinished sections use the new workload. No additional paid review
or rediscovery is introduced. Whole-video quality and speed still require
real-footage QA before claiming a production improvement.

Example real-footage benchmark:

    node tests/local-video-e2e.mjs "C:\Users\A\Downloads\Chelsea-2-2-Hull-City-HIGHLIGHTS.mp4" --port=8795 --provider=gemini --discovery-model=gemini-3.8-flash --script-model=gemini-3.8-flash

Local rollout observation (2026-10-07, Chelsea–Hull upload, job
`945af309-921c-4a30-aa48-8b30cfaf6a2d`): the two completed Pro/3fps sections
were restored without new Gemini calls. Unfinished sections 3 and 4 used
Flash/2fps and completed in 55.315s and 55.031s, with 103,031 and 100,594 input
tokens. Earlier Pro/3fps requests used about 150,000 input tokens. These are
different source sections, not a controlled model-quality comparison. Step 1
selected 15 scenes and reached separate source-clip preparation. Precise
portrait tracking, narration and final-export QA are still pending; no
end-to-end runtime or production-quality improvement is certified yet.

## Flash lifecycle migration (2026-10-07)

Google recommends `gemini-3.8-flash` as the replacement for `gemini-3.6-flash`
(retiring November 19, 2026) and `gemini-3.7-flash` (retiring January 28, 2027):
https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions.
Deployment templates now select 3.8 Flash for discovery/script roles. At worker startup, exact retiring
model IDs in all four Gemini role settings are explicitly migrated to 3.8 and
logged. Saved-test restart overrides receive the same migration. Pro models,
TTS, traffic tier, pricing settings and retry policies are not changed.
Existing running workers are not hot-reconfigured or interrupted; the change
requires a worker reload or deployment. Existing evidence retains its actual
model provenance; it is not relabeled as 3.8 evidence. No 3.8 full-video quality
or capacity improvement is claimed before a representative export passes QA.

No billing purchase or Provisioned Throughput reservation is performed by
these code changes. Deployment and end-to-end QA must be reported separately.

## Initial footage benchmark (2026-10-07)

Historical measurements below used 3.7 Flash, not 3.8. They do not validate
the replacement model.

Chelsea–Hull, original duration 625.45s; new job
`46df1484-9d42-4529-bf97-2b140fdd3806` under
`work/local-e2e-1791339132315`. Four discovery requests completed with
Gemini 3.7 Flash in 24.104, 45.879, 84.279 and 31.481 seconds
(185.743s combined). The previous Pro pass took 653.186s combined.
Input tokens across these requests decreased from 531,401 to 363,300.
This is a joint workflow/model benchmark, not an isolated model comparison.
The new job proceeded directly to independent source-score verification
without the redundant full-source extra-action pass.

These measurements cover discovery only. Complete goals, portrait tracking,
authored narration and the finished export have not yet passed final QA.
Flash is therefore not globally promoted by this preliminary result.
