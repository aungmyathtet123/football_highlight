# Gemini input reductions — 2026-10-08

Implemented locally; production deployment and completed-video timing/quality
acceptance remain separate gates. Google 429 waits are not guaranteed to end
within a fixed time, and failed requests without usage metadata are not counted
as billed input.

## Changes

- Whole completed-edit narration overview: 2 FPS, MEDIUM spatial detail instead
  of 6 FPS HIGH. The entire muted video remains present, with its actual output
  clock. Precise action facts and result restrictions still come from the
  unchanged HIGH-detail source/crop observations. Scorers cannot be guessed.
- One compact reviewed scene packet: exact scene IDs/order/output windows,
  source intervals/action phases, crop facts, verified identities, narration
  word guidance and disputed-outcome restrictions. Detector coordinates,
  duplicate source descriptions, overlay rows and a second observation timeline
  are not sent to the completed-video writer. Legacy writing remains unchanged.
- Identical source bytes + exact interval + model + observation contract share
  one source-action request, including concurrent callers. Separate scene-ID
  provenance remains intact; different footage, intervals or models never
  share an observation. This is not a shortcut for portrait crop approval.
- Valid JSON inside a complete markdown wrapper is parsed locally. Truncated,
  ambiguous or invalid JSON still requires a valid response. No fields, scene
  IDs, outcomes or missing data are synthesized.
- Provider `cachedContentTokenCount` is recorded by workflow category alongside
  input/output/thinking tokens and capacity/timeout counts. Cached input is a
  subset of prompt tokens, not additional tokens. No explicit provider cache
  storage or paid tier was enabled.

## Checkpoints and unchanged quality gates

An existing approved visual master is not rerendered when the narration review
profile changes; only its small, signature-bound review proxy is generated.
Exact approved narration checkpoints can still be reused after validation.
Script content corrections remain text-only. Whole source discovery, action
guide detail, ball detector observations, 12 FPS HIGH portrait reviews, goal
coverage, smooth camera constraints and final media validation are unchanged.
Section overlap is retained: removing context blindly could lose cross-boundary
touches and goals. No model/tier change, added successful-call rate delay,
shortened source selection, cache deletion or production deployment occurs here.

## Expected versus measured savings

Google documents about 280 visual tokens/frame for Gemini 3 HIGH, and 70 for
MEDIUM. A 94-second writer video is therefore approximately 157,920 versus
13,160 visual input tokens: 91.7% less **for this video part**, not for the
whole job. Prompt text, output, thinking, cache hits and provider availability
also affect actual cost/latency. Do not present this estimate as measured
completed-video speed or billing.

Regression tests cover actual writer requests and checkpoint reuse, exact
identity/timing/outcome restrictions, concurrent duplicate observation reuse,
changed-source/model cache rejection, JSON wrapper parsing/truncation, token
accounting, and unchanged critical media defaults.

Verification: **743 JavaScript tests and 118 Python tests passed**. These are
regression checks, not a completed new export or end-to-end speed measurement.
The existing local processor is still finishing its in-flight crop requests;
the new server code takes effect at the next processor load. It has not been
deployed to production, and no current job or cache has been deleted.

Reference: [Google media-resolution documentation](https://ai.google.dev/gemini-api/docs/media-resolution).
