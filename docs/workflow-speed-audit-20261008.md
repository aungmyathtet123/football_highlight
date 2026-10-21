# Whole-workflow speed audit — 2026-10-08

This is a local diagnostic, not a completed-video speed certification. Do not
deploy until the current UI job and the subsequent fresh fixtures pass QA.

## Actual execution order and avoidable cost

| Step | Current implementation | Speed finding |
| --- | --- | --- |
| Upload / probe | Store the uploaded source, validate duration and metadata | Browser must finish upload before offline processing can begin |
| Source discovery | Local shot ledger; overlapping section videos, one initial Gemini response per section | Responses/proxies cached; no broad discovery from Step 2 |
| Choose complete actions | Short same-source action guides; authoritative scoring guides; exact source coverage | Extra guides protect complete touches/results; these are not per-frame model calls |
| Save separate source scenes | Original-ratio, normal-speed, muted clips | Separate saved assets survive retries |
| Portrait tracking | One native detector process; saved observations; crop reviews overlap scene detection | Largest local CPU cost; native frame rate/detail retained |
| Verify actual crops | Actual scene videos at 12fps HIGH detail; at most two review workers; adaptive provider cooldown | Largest current external delay: repeated Google 429 capacity responses |
| Resolve finish ambiguity | Two short matching finish videos at 16fps, saved earlier evidence retained | Removed redundant full-scene input; approximately 65% less visual input in the current miss |
| Effects / visual master | Deterministic scene edits, exact clock, muted completed master | Saved master is reused; no picture changes for voice timing |
| Final script | One whole completed-edit video request, basic English, exact scene windows | No per-scene whole-video script requests |
| Voice | Two independent timed sections at a time; cached recordings | Only overlong sections are shortened/re-recorded, never the whole master |
| Export / QA | Subtitles + voice on the visual master, loudness normalization, technical checks | No source rediscovery or tracking during final mux |

## Implemented during this audit

1. CPU thread pinning after YOLO setup. The installed Ultralytics CPU device
   initialization resets PyTorch's earlier thread limit to 8 on this machine.
   A supported `on_predict_start` callback now reapplies the worker-aware
   budget before inference. One shared detector gets 4 threads on this
   12-logical-core PC; concurrent legacy workers and smaller hosts are bounded.
   Optional `TRACKING_CPU_THREADS=0` selects automatic budgeting. Detector
   weights, pixel resolution, FPS, camera coordinates and evidence contracts
   are unchanged. Existing observations are not invalidated.
2. Durable per-workflow-phase wall measurements and separate Gemini request
   count, errors, scheduler wait, service time and token usage. Stored as the
   job's `performance` field. No prompts, source payloads or secrets recorded.
   Parallel request resource time is not presented as additive job wall time.
   Offline restart time is not invented as active processing time; old jobs
   without metrics begin measurement only after this update is loaded.

## Local measurements

Read-only detector timing used three native source frames (96s, 168s, 269s),
two repeats, unchanged role weights at 960px and ball weights at 1280px.

| CPU threads | Role detector median | Ball detector median |
| --- | --- | --- |
| 1 | 1.3351s | 0.2529s |
| 2 | 0.7574s | 0.1509s |
| 3 | 0.5620s | 0.1351s |
| 4 | 0.5121s | 0.1167s |
| 6 | 0.5533s | 0.1257s |

All sampled boxes/class/confidence outputs remained numerically equivalent
within `rtol=1e-4, atol=.03`. A second 4-vs-8 thread run measured 0.5055 vs
0.5231s role and 0.1154 vs 0.1203s ball. This is a modest inference improvement
over the library's actual 8-thread setting, **not a multi-fold total job speedup**.
The callback canary confirmed 4 actual threads on both models.

The current optimized Gemini finish request succeeded in 94.977 seconds
including scheduler time, with 24,981 prompt tokens. Earlier larger input had
timed out. This is one focused success, not a total-job benchmark.

Verification: 733 JavaScript tests and 118 Python tests pass. The current
processor is intentionally left running with its in-flight crop requests;
the new server-side timing instrumentation and worker-count argument take
effect at the next normal processor load, not by restarting this test again.
CPU callback code takes effect when a new Python detector is launched. The
current job already has its native observations, so this is a future-run
optimization, not a claim of faster ongoing Google requests. No deployment.

## Next options, not silently enabled

- Benchmark an optimized inference backend with the same weights and native
  detail, then compare complete camera/ball continuity; do not substitute a
  cheaper inaccurate detector merely to report lower latency.
- Benchmark a faster configured reviewer on already verified and known-bad
  crops before changing deployed routing. Do not weaken false-positive or
  missing-goal checks to escape Pro capacity waits.
- Do not increase Google requests to 10 concurrent workers during 429 responses.
  Native CPU speed cannot resolve Google's busy shared model pool. Total time
  with that wait remains variable.

References used: [PyTorch CPU thread controls](https://docs.pytorch.org/docs/stable/generated/torch.set_num_threads.html),
[Ultralytics prediction callbacks](https://docs.ultralytics.com/usage/callbacks),
[Ultralytics optimized CPU export](https://docs.ultralytics.com/integrations/openvino).
The export vendor's possible speedups are not assumed for this AMD host.
