# Football tracking evidence — 18 October 2026

## What was measured

The saved production regression records contain 33 scenes: 30 portrait scenes
from two uploads and three landscape scenes from another upload. Pipeline
approvals are model decisions, not reference labels. There are currently no
human-verified crop labels, so full-pipeline accuracy is unknown.

An external detector sample uses 72 frames from 12 SoccerNet tracking sequences
covering three matches. Of those, 66 frames have a ball reference box; six are
excluded rather than treated as negative examples. The dataset revision and
image hashes are pinned in `benchmarks/soccernet-manifest.json`.

## Isolated detector baseline

Both models used confidence 0.03, input size 1280 and CPU inference on the same
66 labelled frames. A box match requires intersection-over-union of at least
0.5. Center recall uses a distance threshold of the larger of four pixels and
half the reference box diagonal.

| Detector | Box precision | Box recall | Center recall | False positive boxes |
| --- | ---: | ---: | ---: | ---: |
| Current football specialist | 20.2% | 33.3% | 51.5% | 87 |
| General sports-ball model | 13.9% | 42.4% | 48.5% | 174 |

These are raw, low-confidence detections before trajectory association and
camera constraints. They do not measure production crop quality. The sample
is small, uses the official training partition, and overlap with model
pretraining is unknown. It cannot support a held-out accuracy or all-video
reliability claim. No weights were trained or changed.

The general detector found more matching boxes but also generated twice as
many false positives. This does not justify replacing the current detector.
Training requires additional trusted labels, hard negatives and separate
matches for validation and final testing.

## Confirmed production failure mechanisms

- A valid flight observation could fall after an editorial payoff lead-in,
  causing a coherent review to fail timing validation.
- Native association could follow a spare ball or white background feature
  during the final shot instead of the moving match ball.
- The coarse event label could describe a penalty award while the selected
  interval actually showed open play. Event correction needs an independent
  source observation and an independently complete portrait crop.
- Independent video reviewers sometimes supplied different decisive-touch
  clocks. A confident second answer must not silently replace the action.
- The keeper's first parry and later secure collection can be different valid
  resolution times for one save. This is distinguished from a changed shot
  contact, goal crossing or intervening follow-up attempt.
- Recovery lacked a bounded, genuinely changed native camera plan after a
  negative crop verdict. Repeated identical reviews cannot fix the pixels.

The shared changes address these mechanisms while preserving the locked
source intervals and full-screen 9:16 requirement. A newly rendered crop
still needs its own passing review. Unknown outcomes remain unverified.

Timestamped contact-frame pairs supplement the two complete videos when an
independent comparison is necessary. They expose both the tentative contact
and the crop-observed contact without generated ball coordinates.

## Production verification

On 18 October, worker generation 79 resumed the saved job and reused its 12
approved scenes. All 16 scenes subsequently passed the production keyframe
gate. All locked source intervals were unchanged, and the requested aspect
ratio remained 9:16. The job advanced to fixture research for narration.
This verifies the deployed recovery on this run; it is not a final-video
approval or a guarantee for unseen footage. See `production-runs/2026-10-18/`
for the immutable image digest and saved status evidence. Chrome was not
connected, so this run was checked through server access rather than the UI.

## Additional Dortmund–Bayern regression

A new production upload exposed three additional failures after the earlier
run passed: a celebration camera constrained by an irrelevant football, a
coarse save label hiding a penalty award and referee signal, and a rapid
finishing action whose observed setup was shorter than the fixed 150 ms rule.

The shared repair now recomposes reactions and referee decisions from saved
native detections. A continuous constrained pan hands off after the challenge
and reaches the official by the observed signal. Reaction crops still need
positive subject and stability reviews. Gameplay retains its measured ball
containment requirements. Short, independently observed setup is allowed at
the sampled frame cadence; unseen or simultaneous setup remains rejected.

Worker generation 80 resumed the same checkpoint and all 15 required scenes
passed. Chrome's production UI showed 15/15 approved and zero needing repair.
All locked source intervals and full-screen 9:16 settings were preserved. The
job advanced to match research; final-video completion is a separate gate.
The patch passed 70 focused JavaScript and 23 native tracking checks. Source,
canary and production evidence is saved in
`regressions/2026-10-18-dortmund/`. No model weights were trained.

## Reproduce and extend

See `README.md` for collection and reference-label requirements. The benchmark
scripts are `tools/prepare-football-benchmark.py` and
`tools/benchmark-football-ball.py`. Obtain media from the original dataset;
only manifests and numeric reports are stored here.

Dataset: https://www.soccer-net.org/tasks/tracking

Pinned release: https://huggingface.co/datasets/SoccerNet/SN-Tracking-2023
