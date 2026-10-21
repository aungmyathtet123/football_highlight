# Transport-only Gemini model failover

## Implemented locally

The old retry loop could retry one busy model indefinitely. The replacement
chooses the first eligible model without an active provider cooldown. A 429 or
temporary 408/499/500/502/503/504/transport failure cools down that model, then
the same request may immediately use another qualified model. No simultaneous
three-model race, new source discovery, changed scene boundaries, or lowered
visibility checks is introduced. Healthy calls have no fixed rate pacing.

Queued calls check the model again before network admission, so another scene's
429 cannot cause a stale queued call to hit the same known-busy endpoint.
Actual network requests still share the existing global concurrency cap.
Model cooldowns persist independently across worker restarts and keep the
longest Retry-After. If every eligible model is busy, the earliest eligible
cooldown is awaited. This cannot override Google's resource availability.

Primary authentication/schema errors remain errors. A 403/404 from an optional
backup disables that backup for this worker; it does not trigger repeated
unavailable-model probes. Caller cancellation is not a failover condition.
False visual verdicts are returned unchanged, never retried on another model
to obtain an approval. The response's requested and actual model attribution
is persisted with raw JSON evidence, independently of SDK readonly objects.

## Current role pools

| Role | Primary | Eligible backup models |
| --- | --- | --- |
| Discovery/research | gemini-3.8-flash | gemini-3.5-flash, gemini-3.1-pro-preview |
| Recap script | gemini-3.8-flash | gemini-3.5-flash, gemini-3.1-pro-preview |
| Precise framing / configured base Pro tasks | gemini-3.1-pro-preview | gemini-3.5-flash |

These pools are visible in the processor's `/health` response. The local `.env`
and example contain `GEMINI_MODEL_FAILOVER`, `GEMINI_FAILOVER_MODELS`, and
`GEMINI_FRAMING_FAILOVER_MODELS`. The framing pool is now enabled locally,
using positive and negative crop controls plus a deterministic media-length
preflight. An explicit empty framing pool still disables it. Lite and the
previously identified retiring model families are not automatic backups.

## Real framing qualification, not a completed-video claim

Used the production video-only crop-review request/schema, native 12fps video,
MEDIUM thinking and 8,192 output limit on saved original diagnostic crops.
No diagnostic wrote a job approval or edited the source/selected scenes.

| gemini-3.5-flash case | Result | Successful observation seconds |
| --- | --- | --- |
| Complete goal crop | Correct acceptance | 48.593 |
| Complete save crop | Correct acceptance on subsequent bounded test | 14.809 |
| Complete disallowed-goal finish | Correct acceptance | 71.395 |
| Wrong-side crop | Correct rejection in a subsequent bounded test | 129.363 |
| Missing-finish crop | Rejected by media preflight before an API call: 1.833s file for an 8.4s locked scene | No API request |

The first save probe also received a 429. Earlier wrong-side probes received
499/429/504 and missing-finish probes received 504. These remain failed calls,
not approvals. Qualification comprises four actual model verdicts and one
deterministic file-integrity rejection, not five successful model verdicts.
Earlier 3.8 Flash qualification disagreed on a visible scoring case and remains
disabled for critical framing. Passing easy examples alone is not sufficient.

Google's current Gemini 3.x migration instructions deprecate explicit
temperature/topP/topK settings. The shared production request path and diagnostic
use model defaults for these settings; older families remain unchanged. No
media-detail reduction, lower quality threshold or relaxed schema is made.
The earlier successful controls used the old sampling configuration. A fresh
complete-goal control using defaults also passed in 35.418s; the next save call
received 429. The change is not evidence that sampling settings caused capacity
errors, nor a claim that all controls passed in a single uninterrupted run.

Reports: `work/capacity-crop-flash35-20261008/report.json`,
`work/capacity-crop-flash35-remaining-20261008/report.json`, and
`work/capacity-crop-flash35-negative-20261008b/report.json`,
`work/capacity-crop-preflight-20261008/report.json`, and
`work/capacity-crop-flash35-qualified-20261008/report.json`.

All 792 JavaScript tests passed, including processor-level 429/service failover,
unchanged evidence/schema, negative-verdict preservation, exact attribution,
authentication rejection, unavailable backup exclusion, model-specific restart
cooldowns, queued-call race checks, preserved negative crop verdicts and bounded
rejected-camera recovery. Only the verified local processor was reloaded.
In the real saved job `fa69cd20-e456-4e21-8501-8b3e2c216ac8`, a primary 500
on `initial-2-10` triggered Pro-to-3.5-Flash switching. Flash completed the actual
crop review in 26.780s and its outcome check in 63.722s. Actual-model provenance
is saved in both reviews. Approved crops increased from 7/12 to 9/12.

The remaining three failures are visibility/evidence issues, not transport
failover being disabled. A positive but incomplete phase report now gets one
cacheable decisive-video observation. It cannot promote a negative camera
verdict. A genuinely rejected fast crop reaches the existing visual camera
planner instead of repeatedly reusing the rejected native path. Its locked
source interval is unchanged and the new actual crop must still pass review.
The two live focused phase checks (57.929s and 58.999s) returned negative
visibility evidence. Those negatives were preserved, not treated as timestamp
fixes or promoted to approval. The three failed cameras are now being planned
and independently reviewed through the visual recovery path.
The initial visual recovery also exposed a separate output-format problem:
HIGH reasoning used 21,102 tokens of a 24,576 ceiling before complete coordinate
JSON could be emitted. Another returned six sparse rows with two-number ball
points instead of the required rectangles. The initial observation request
now uses MEDIUM and a 32,768 output ceiling, with four-value box lengths enforced
in its schema. Visibility, scene clocks, box validity and crop approval remain
strict. Complete old observations remain cached; a legacy response missing a
majority of rows may be reopened once under request contract v2. A new-contract
incomplete answer is saved and is not repeatedly paid for on job retries.
The subsequent MEDIUM control finished without truncation (72.591s, 3,293
thinking tokens), but supplied only 19 usable rows for 80 requested timestamps.
This remains a failed observation, not a successful camera test. Request contract
v3 attempted to enforce response-array length in the provider schema. The live
test rejected that request with 400 INVALID_ARGUMENT. It was not ready to use.
On October 9, bounded 80-, 32-, and 8-row diagnostic controls also returned 400.
The same video request without array-length constraints returned eight valid
rows in 34.468s and all 80 requested rows in 109.411s. The 80-row control used
26,091 input tokens, 14,344 output tokens and 4,788 thinking tokens; its phase
and contact-box validators also passed. These are request/observation controls,
not rendered-camera approvals.

Request contract v4 therefore uses named rectangle edges on the wire, with a
lossless conversion to the existing four-edge arrays, and removes provider
array-count constraints. Exact counts, indexes, clocks, box geometry and actual
visibility still validate locally. Missing edges or omitted rows cannot become
approved coordinates. Complete earlier observations remain reusable. Reports:
`work/framing-schema-v4-80unbounded-20261009/report.json` and
`work/framing-schema-v4-unbounded-20261009/report.json`. All 793 JavaScript tests
pass at that checkpoint. The saved local job was resumed through the UI with its nine approved
crops intact; a primary 429 again selected 3.5 Flash for the remaining video
observation. This does not yet establish a finished 12/12 edit.
The resumed Flash request spent 30,429 thinking tokens and emitted only 2,324
output tokens before exhausting the 32k ceiling. Its LOW/64k retry and a later
Pro attempt both hit 180-second service deadlines. They are failures, not
approvals. Dense coordinate requests on 3.5 Flash now reserve a 65,536 ceiling
on the first call without reducing MEDIUM effort or changing the response
schema or crop-review settings. This prevents the observed 32k ceiling from
necessarily truncating the answer, but does not guarantee a timely response.
The live first-request Flash control subsequently returned all 80 valid rows
for `initial-2-7` in 116.897s (22,026 thinking tokens, 9,866 output tokens), with
no rectangle/contact validation issues. A second scene returned 78 valid rows
in 157.631s (21,153 thinking tokens, 23,722 output tokens); two opening run-up
rows still conflicted with the contact/control rule. No JSON budget retry was
needed for either result. This confirms the output-budget fix, NOT camera
correctness. Legacy malformed-box caches can reopen once under the corrected
contract; complete caches and new-contract failures cannot trigger replay loops.
The local processor was reloaded with those changes, retaining source scenes
and all nine approved crops. All 796 JavaScript tests now pass. The full edit
is still unfinished; no final video URL or production deployment is claimed.
The latest local test stopped at 9/12: `initial-2-7`'s complete coordinate plan
omitted the payoff phase, despite the source containing the shot consequence.
Its focus notes also disagreed about the action between windows. This is a
semantic/coordinate consistency failure, not a provider wait or a valid camera.
Inspection of `initial-2-4`'s source opening confirmed a run-up close-up with
the full player's left edge and ball's right edge spanning approximately 40.9%
of source width, while a full-height 9:16 crop of 16:9 contains approximately
31.6%. Position alone cannot contain both full boxes in that opening. Correct
initial shot selection / action-phase direction remains required. No negative
evidence was overridden, no source scene was silently omitted, and narration
and final rendering have not begun.
Real visual verification of this new output contract is still in progress;
the unit tests alone do not establish that these three cameras now pass.
Restart-only recovery uses five seconds rather than a provider-error backoff;
persisted provider cooldowns are still honored separately.
No production deployment, billing/quota change, purchased reservation, cache
deletion, or completed-video claim is made by this change.

## Remaining limitation

### October 9 coherent action-plan correction

The missing-payoff error was reproduced in the UI with job
`fa69cd20-e456-4e21-8501-8b3e2c216ac8`. The 80-position legacy response's
focus notes and phase rows disagreed; a complete array is not a correct camera.
A separate source-only phase experiment also contradicted the coordinate
observations. That extra model call is **not in the production tracking path**.

Request contract v5 emits one complete source timeline and position observations
in the **same initial video response**. It distinguishes pre-touch approach
from possession, retains a shot's payoff when a subsequent defensive clearance
continues, and validates interval coverage locally. Geometry, identities and
source cuts are never invented from the timeline. Actual crop review remains
independent and mandatory. Complete/approved caches remain valid. Only a
demonstrably incomplete v4 first window can upgrade once; the old response is
archived. A v5 semantic or geometry failure cannot cause another paid upgrade
on Resume. Invalid timeline answers are checkpointed before validation too.

All 805 JavaScript tests pass, including paid-cache/no-repeat regressions, and
the production build passed. The UI test was resumed locally with nine approved
crops intact. Pro returned 429; both dense fallback runs then hit the old 180s
service deadline. Dense first requests now budget 360s instead of discarding
provider work at 180s. This is a bounded deadline, not a speed/availability
guarantee. The full video is still unfinished; no production deployment or
finished-video claim is justified yet. The worker was subsequently reloaded
with the checkpoint/deadline safeguards after its obsolete technical-recovery
path repeated the rejected v4 upgrade. The already-paid v5 responses are
recovered from their exact scene cache, without another API observation.

Live responses also used inclusive 8fps phase ranges and one-tick contacts;
those are losslessly decoded without moving a touch or filling an unobserved
gap. A partial first-window phase map explicitly records its observed-through
clock and does not invent the final window. Original phase labels stay saved.
Semantic timeline failures now use `INITIAL_FRAMING_PLAN`, not a generic
technical failure which restarts the same model request automatically.

The post-reload UI test remains at 9/12 approved, with all 12 split clips saved.
It now reports a real visual contradiction at 4.125s in `initial-2-7`: the
observed ball box is far from the actor claimed to be making contact. That
contradiction is not repaired by relabelling it or ignoring visibility checks.
The repeated timing/cache loop is fixed, but the three remaining cameras are
**not fixed or approved**. The job is in attention state, not capacity waiting.
No final MP4, production deployment, scene deletion or false approval occurred.

Local code can avoid waiting on a busy model when a suitable healthy backup
exists. It cannot promise zero capacity waits when all suitable models reject
requests. Framing switching is enabled and observed live, but the full video
was not completed at the time of this update. The local review is ongoing;
no quality-contract bypass or production deployment is implied.

Google reference: [Reduce 429 errors on Vertex AI](https://cloud.google.com/blog/products/ai-machine-learning/reduce-429-errors-on-vertex-ai).
Sampling reference: [Gemini model migration instructions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate).
