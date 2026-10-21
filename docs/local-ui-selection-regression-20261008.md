# Local UI selection regression — 2026-10-08

Production deployment is blocked until fresh, multi-source UI exports have
completed and passed picture/audio review. A passing unit test is not an
end-to-end video certification.

## Reported failure

The fresh Netherlands–Germany UI upload
`fa69cd20-e456-4e21-8501-8b3e2c216ac8` stopped before its scene lock because
one initially observed scoring incident disappeared during source selection.
Both awarded goals were present. The conflict was a corner initially labelled
as a disallowed goal, while its shorter source guide described a blocked shot.
The raw scoring ledger continued to require that incident. Automatic recovery
then repeated the unchanged cached contradiction until its no-progress limit.

## Global changes

- Required scoring source guides use the configured authoritative review
  model. Optional chances use the discovery model. Completed unrelated source
  observations are not repeated.
- A broad scoring hypothesis can be corrected only by complete, same-source
  authoritative contact/result evidence with no recorded uncertainty. The
  actual action stays eligible; stale goal/VAR narration and graphics are
  removed. Exact source/model/window provenance is retained.
- Coverage accepts either a retained scoring action or that audited correction.
  Missing/uncertain evidence cannot silently satisfy goal coverage.
- A deterministic unresolved source-selection conflict no longer repeats the
  identical saved observations three times. Temporary provider errors still
  wait and retry the unfinished request automatically.
- Independent completed hybrid crop reviews now checkpoint their per-scene UI
  approvals immediately, rather than displaying all scenes as waiting until
  the full detector batch finishes. This reporting change does not approve or
  alter a camera path. It is loaded and its restored 6/12 approved count has
  been checked in the live UI.
- A live missed-shot crop review exposed a goal/non-goal disagreement. An
  otherwise complete contradictory video review now gets one cached 16fps
  finish comparison of the exact crop and corresponding original wide source.
  The wide source establishes the goal plane, not crop visibility; the actual
  portrait still must show the result. No JPEG analysis, scene-boundary change,
  repeated tracker or automatic approval is introduced. An unresolved result
  stays unapproved.
- The focused comparison no longer resends the full scene: only the matching
  portrait and wide finish excerpts are supplied. Earlier setup/pass evidence
  remains immutable and is merged from the saved full-crop review. Earlier
  false visibility flags or issues cannot be cleared by a short finish review,
  and returned evidence outside the supplied interval is rejected. For the
  current 10-second miss and 2.833-second finish, requested video samples drop
  from approximately 256 to 91 (about 65% less visual input). This is an input
  reduction, not yet a measured end-to-end speed claim or capacity guarantee.
- Processor restart recovery now resumes interrupted active stages from their
  checkpoints. Previously, those jobs could retain a "tracking" status with no
  in-memory worker, while UI Reconnect only polled forever. Uploaded originals,
  completed exports and attention/failed jobs are not restarted automatically.
  Cached approved crop states are also restored to the progress UI immediately.

## Test evidence so far

- 729 JavaScript tests pass, including actual source-selection handoff,
  streamed crop-progress and cached video finish-comparison regressions.
- 115 Python tests pass.
- Retried the paused job using the UI, not a job-file mutation or start API.
  Step 1 passed and saved 12 separate source clips, approximately 94 seconds.
  Both awarded goals and both observed disallowed-goal actions remain selected.
- The authoritative new guide retained the disputed corner as a disallowed
  goal. This live case therefore tested stronger source observation, not the
  non-goal correction branch; that branch has separate regression coverage.
- All 12 scenes' detector observations are saved. After the processor reload,
  native scene checkpoints were reused with zero new frames checked. Six of
  twelve actual portrait crops are approved. The remaining reviews, including
  the missed-shot finish comparison, are waiting on provider capacity. No final
  MP4 has yet been certified for this job. No production deployment has occurred.
- The finish-only optimization is loaded into the local processor. The same
  job resumed automatically from its saved native/approved crop checkpoints;
  it was not uploaded or rediscovered again. The live UI confirms 12 separate
  source clips and 6/12 verified crops. Google is still returning capacity
  responses. The local detector is CPU-only on this machine (no CUDA device).
- The first optimized finish request succeeded at 07:40 UTC: 24,981 prompt
  tokens, 433 output tokens, 827 thinking tokens, 94.977 seconds including
  scheduler time. Its independently observed non-goal result passed the crop
  gate and the job advanced to 7/12 verified crops and the next scene. The
  earlier larger request had timed out; this is one successful focused check,
  not a completed-video performance benchmark. Google downgraded requested
  priority to ON_DEMAND for this response.

## Remaining acceptance gates

1. Finish this UI job and inspect complete actions, moving-ball framing,
   narration truth/pacing, subtitles, audio and output playback.
2. Verify subsequent independent approvals continue to update the live UI.
3. Upload and complete fresh Chelsea–Hull and Brentford–Chelsea tests through
   the same real UI. Automated file selection currently needs the user to
   enable the Chrome extension's file-URL access, or select the files themselves.
4. Record the actual results; fix any global defect exposed by those tests.
5. Only then consider production deployment.
