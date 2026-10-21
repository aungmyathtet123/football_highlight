# GPU tracking canary

This is an opt-in path, not a verified ten-minute production guarantee.
The deployed CPU/Gemini worker remains unchanged until crop and full-export
checks pass. Cloud Run GPU, CPU, memory and Gemini requests are billable.

## Pipeline

1. Gemini selects complete source actions. Keep scene boundaries and clocks.
2. One Python process loads the football-role and small dedicated ball models
   once, then tracks all selected scenes separately using BoT-SORT. Detection
   checkpoints survive retries. Clips are not concatenated for detection.
3. The constrained camera converts dense observations into stable 9:16 paths.
4. At most two independent Flash reviews inspect actual 12 fps portrait clips
   concurrently. Fast review sends video only, not repeated JPEG batches.
   Bad observed geometry or an unobservable action cannot be approved in code.
5. Effects and narration use approved evidence. Encode with NVENC only after
   checking that the installed FFmpeg and GPU can actually encode.

Explicit worker settings after validation:

```text
KEYFRAME_PROVIDER=hybrid
FAST_TRACKING_ENABLED=true
TRACKING_DEVICE=0
GEMINI_FRAMING_REVIEW_MODEL=<tested available Flash model>
TRACKING_SCENE_CONCURRENCY=2
VIDEO_ENCODER=h264_nvenc
```

Build `Dockerfile.worker-gpu` against the current immutable CPU worker image.
Use a separate Cloud Run Job with one NVIDIA L4, 4 CPU and 16 GiB RAM. Never
change production solely because a build succeeds. First run
`tools/benchmark-football.mjs` on private source/manifest/shot objects. Save raw
tracking, per-scene portrait MP4s, contact sheets and stage timings to a private
benchmark prefix. Inspect source-to-crop ball continuity as well as measurements.
Benchmark clips are diagnostics, not finished recaps.

Your Windows machine has no CUDA GPU. Its CPU measurements are useful as a
baseline but cannot establish L4 performance or production end-to-end time.
Model inference, scene detection, render filters, narration and provider waits
all contribute to elapsed time; GPU encoding does not accelerate CPU filters.

## October 7 canary status

The three-scene CPU benchmark processed 17.16 seconds in 155.3 seconds
(151.7 tracking, 3.7 diagnostic encoding). Two geometry checks passed; one
reported excessive within-shot camera speed. The independent Flash video
review of another crop rejected an unclear final touch/outcome. These are
real negative results, not complete-export approval.

GPU job creation was refused by Google in both `asia-southeast1` and
`us-central1`: the project has no quota for GPU use without zonal redundancy.
Request at least one Cloud Run NVIDIA L4 GPU in the Google Cloud Quotas
console before executing the isolated GPU job. Do not silently fall back to
CPU or advertise a verified ten-minute turnaround. The production worker
has not been switched to this path.
